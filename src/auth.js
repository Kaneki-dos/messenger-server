const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { q, publicUser } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TTL = '30d';

const sign = (user) => jwt.sign({ sub: user.id }, SECRET, { expiresIn: TTL });

async function verify(token) {
  try {
    const { sub } = jwt.verify(token, SECRET);
    return (await q.userById(sub)) || null;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const user = await verify(header.replace(/^Bearer /i, ''));
  if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = user;
  next();
}

const router = express.Router();

router.post('/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim() || username;

  if (!/^[a-z0-9_.]{3,24}$/i.test(username)) {
    return res.status(400).json({ error: 'Usernames use 3–24 letters, numbers, dots or underscores.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Passwords need at least 8 characters.' });
  }
  if (await q.userByUsername(username)) {
    return res.status(409).json({ error: 'That username is taken. Try another.' });
  }

  const user = {
    id: nanoid(12),
    username,
    display_name: displayName,
    password_hash: await bcrypt.hash(password, 10),
    created_at: Date.now()
  };
  await q.insertUser(user.id, user.username, user.display_name, user.password_hash, user.created_at);
  res.status(201).json({ token: sign(user), user: publicUser(await q.userById(user.id)) });
});

router.post('/login', async (req, res) => {
  const user = await q.userByUsername(String(req.body.username || '').trim());
  const ok = user && await bcrypt.compare(String(req.body.password || ''), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'That username and password do not match.' });
  res.json({ token: sign(user), user: publicUser(user) });
});

module.exports = { router, requireAuth, verify, sign };