const { nanoid } = require('nanoid');
const { q, publicMessage } = require('./db');
const { verify } = require('./auth');
const presence = require('./presence');

const TYPING_TTL = 6000;

function attach(io) {
  io.use(async (socket, next) => {
    const user = await verify(socket.handshake.auth?.token || '');
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', async (socket) => {
    const me = socket.data.user;
    const convRows = await q.myConversations(me.id);
    const rooms = convRows.map((c) => c.id);

    socket.join(`user:${me.id}`);
    rooms.forEach((id) => socket.join(id));

    const timers = new Map();

    if (presence.connect(me.id)) {
      rooms.forEach((id) => socket.to(id).emit('presence', { userId: me.id, online: true }));
    }
    socket.emit('ready', { userId: me.id, conversations: rooms });

    socket.on('message:send', async (payload = {}, ack) => {
      const conversationId = String(payload.conversationId || '');
      if (!(await q.isMember(conversationId, me.id))) {
        return ack?.({ error: 'You are not in this conversation.' });
      }

      const kind = ['text', 'image', 'file', 'audio'].includes(payload.kind) ? payload.kind : 'text';
      const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 4000) : '';
      const attachment = payload.attachment || null;
      if (!body && !attachment) return ack?.({ error: 'Nothing to send.' });

      const dupe = payload.clientId && await q.messageByClientId(me.id, String(payload.clientId));
      if (dupe) return ack?.({ message: publicMessage(dupe) });

      const row = {
        id: nanoid(16),
        conversation_id: conversationId,
        sender_id: me.id,
        client_id: payload.clientId ? String(payload.clientId) : null,
        kind,
        body: body || null,
        attachment_url: attachment?.url || null,
        attachment_name: attachment?.name || null,
        attachment_size: attachment?.size || null,
        attachment_mime: attachment?.mime || null,
        created_at: Date.now()
      };
      await q.insertMessage(row);

      const message = publicMessage(row);
      io.to(conversationId).emit('message:new', message);
      clearTyping(conversationId);
      await q.markRead(row.id, conversationId, me.id);
      ack?.({ message });
    });

    function clearTyping(conversationId) {
      const t = timers.get(conversationId);
      if (!t) return;
      clearTimeout(t);
      timers.delete(conversationId);
      socket.to(conversationId).emit('typing', { conversationId, userId: me.id, isTyping: false });
    }

    socket.on('typing', async ({ conversationId, isTyping } = {}) => {
      if (!(await q.isMember(conversationId, me.id))) return;
      if (!isTyping) return clearTyping(conversationId);

      if (!timers.has(conversationId)) {
        socket.to(conversationId).emit('typing', { conversationId, userId: me.id, isTyping: true });
      } else {
        clearTimeout(timers.get(conversationId));
      }
      timers.set(conversationId, setTimeout(() => clearTyping(conversationId), TYPING_TTL));
    });

    socket.on('read', async ({ conversationId, messageId } = {}) => {
      if (!(await q.isMember(conversationId, me.id))) return;
      const msg = await q.messageById(messageId);
      if (!msg || msg.conversation_id !== conversationId) return;
      await q.markRead(messageId, conversationId, me.id);
      io.to(conversationId).emit('read', { conversationId, userId: me.id, messageId, at: Date.now() });
    });

    socket.on('conversation:join', async ({ conversationId } = {}) => {
      if (await q.isMember(conversationId, me.id)) socket.join(conversationId);
    });

    socket.on('disconnect', async () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      const lastSeenAt = Date.now();
      if (presence.disconnect(me.id)) {
        await q.touchSeen(lastSeenAt, me.id);
        rooms.forEach((id) => socket.to(id).emit('presence', { userId: me.id, online: false, lastSeenAt }));
      }
    });
  });
}

module.exports = { attach };