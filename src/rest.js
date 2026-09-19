const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const { q, publicUser, publicMessage } = require('./db');
const { requireAuth } = require('./auth');
const presence = require('./presence');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 },
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${nanoid(16)}${path.extname(file.originalname).slice(0, 10)}`)
  })
});

const router = express.Router();
router.use(requireAuth);

async function decorate(convo, me) {
  const members = await q.membersOf(convo.id);
  const ids = presence.onlineIds();
  const others = members.filter((m) => m.id !== me.id);
  const last = await q.lastMessage(convo.id);
  const n = await q.unreadCount(convo.id, me.id);

  return {
    id: convo.id,
    kind: convo.kind,
    title: convo.kind === 'group'
      ? (convo.title || others.map((m) => m.display_name).join(', '))
      : (others[0]?.display_name || 'Saved messages'),
    avatarUrl: convo.avatar_url || (convo.kind === 'dm' ? others[0]?.avatar_url : null) || null,
    members: members.map((m) => ({ ...publicUser(m, ids), lastReadMessageId: m.last_read_message_id })),
    lastMessage: publicMessage(last),
    unreadCount: n,
    updatedAt: Number(last?.created_at || convo.created_at)
  };
}

router.get('/me', (req, res) => res.json({ user: publicUser(req.user, presence.onlineIds()) }));

router.get('/users', async (req, res) => {
  const term = `%${String(req.query.q || '').trim()}%`;
  const ids = presence.onlineIds();
  const users = await q.searchUsers(req.user.id, term);
  res.json({ users: users.map((u) => publicUser(u, ids)) });
});

router.get('/conversations', async (req, res) => {
  const rows = await q.myConversations(req.user.id);
  const list = await Promise.all(rows.map((c) => decorate(c, req.user)));
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ conversations: list });
});

router.post('/conversations', async (req, res) => {
  const kind = req.body.kind === 'group' ? 'group' : 'dm';
  const memberIds = [...new Set((req.body.memberIds || []).filter((id) => id !== req.user.id))];

  if (!memberIds.length) return res.status(400).json({ error: 'Pick at least one person to message.' });
  if (kind === 'dm' && memberIds.length > 1) {
    return res.status(400).json({ error: 'Direct messages hold two people. Create a group instead.' });
  }
  const found = await Promise.all(memberIds.map((id) => q.userById(id)));
  if (found.some((u) => !u)) {
    return res.status(400).json({ error: 'One of those accounts no longer exists.' });
  }

  if (kind === 'dm') {
    const existing = await q.findDm(req.user.id, memberIds[0]);
    if (existing) {
      return res.json({ conversation: await decorate(await q.conversationById(existing.id), req.user) });
    }
  }

  const convo = {
    id: nanoid(12),
    kind,
    title: kind === 'group' ? (String(req.body.title || '').trim() || null) : null,
    created_by: req.user.id,
    created_at: Date.now()
  };
  await q.insertConversation(convo.id, convo.kind, convo.title, convo.created_by, convo.created_at);
  await q.addMember(convo.id, req.user.id, 'owner', convo.created_at);
  await Promise.all(memberIds.map((id) => q.addMember(convo.id, id, 'member', convo.created_at)));

  res.status(201).json({ conversation: await decorate(await q.conversationById(convo.id), req.user) });
});

router.get('/conversations/:id/messages', async (req, res) => {
  if (!(await q.isMember(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'You are not in this conversation.' });
  }
  const before = Number(req.query.before) || Date.now() + 1;
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const rows = await q.history(req.params.id, before, limit);
  res.json({
    messages: rows.map(publicMessage).reverse(),
    hasMore: rows.length === limit
  });
});

router.post('/uploads', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a file to upload.' });
  res.status(201).json({
    attachment: {
      url: `${process.env.PUBLIC_URL || ''}/files/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype
    }
  });
});

module.exports = { router, decorate, UPLOAD_DIR };