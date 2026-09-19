const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url    TEXT,
      last_seen_at  BIGINT NOT NULL DEFAULT 0,
      created_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('dm','group')),
      title       TEXT,
      avatar_url  TEXT,
      created_by  TEXT REFERENCES users(id),
      created_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role                 TEXT NOT NULL DEFAULT 'member',
      joined_at            BIGINT NOT NULL,
      last_read_message_id TEXT,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id       TEXT NOT NULL REFERENCES users(id),
      client_id       TEXT,
      kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image','file')),
      body            TEXT,
      attachment_url  TEXT,
      attachment_name TEXT,
      attachment_size INTEGER,
      attachment_mime TEXT,
      created_at      BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client ON messages(sender_id, client_id)
      WHERE client_id IS NOT NULL;
  `);
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const many = async (sql, params) => (await pool.query(sql, params)).rows;
const run = async (sql, params) => pool.query(sql, params);

const q = {
  userByUsername: (username) => one(`SELECT * FROM users WHERE LOWER(username) = LOWER($1)`, [username]),
  userById: (id) => one(`SELECT * FROM users WHERE id = $1`, [id]),
  insertUser: (id, username, displayName, passwordHash, createdAt) =>
    run(`INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, username, displayName, passwordHash, createdAt]),
  touchSeen: (lastSeenAt, userId) => run(`UPDATE users SET last_seen_at = $1 WHERE id = $2`, [lastSeenAt, userId]),
  searchUsers: (myId, term) => many(
    `SELECT id, username, display_name, avatar_url, last_seen_at FROM users
     WHERE id != $1 AND (username ILIKE $2 OR display_name ILIKE $2) LIMIT 20`,
    [myId, term]),

  insertConversation: (id, kind, title, createdBy, createdAt) =>
    run(`INSERT INTO conversations (id, kind, title, created_by, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, kind, title, createdBy, createdAt]),
  conversationById: (id) => one(`SELECT * FROM conversations WHERE id = $1`, [id]),
  addMember: (conversationId, userId, role, joinedAt) =>
    run(`INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`, [conversationId, userId, role, joinedAt]),
  isMember: async (conversationId, userId) =>
    !!(await one(`SELECT 1 FROM members WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId])),
  membersOf: (conversationId) => many(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.last_seen_at,
            m.last_read_message_id, m.role
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.conversation_id = $1`, [conversationId]),
  myConversations: (userId) => many(
    `SELECT c.* FROM conversations c
     JOIN members m ON m.conversation_id = c.id
     WHERE m.user_id = $1`, [userId]),
  findDm: (userId, otherId) => one(
    `SELECT c.id FROM conversations c
     JOIN members a ON a.conversation_id = c.id AND a.user_id = $1
     JOIN members b ON b.conversation_id = c.id AND b.user_id = $2
     WHERE c.kind = 'dm' LIMIT 1`, [userId, otherId]),

  insertMessage: (row) => run(
    `INSERT INTO messages
      (id, conversation_id, sender_id, client_id, kind, body,
       attachment_url, attachment_name, attachment_size, attachment_mime, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.id, row.conversation_id, row.sender_id, row.client_id, row.kind, row.body,
     row.attachment_url, row.attachment_name, row.attachment_size, row.attachment_mime, row.created_at]),
  messageById: (id) => one(`SELECT * FROM messages WHERE id = $1`, [id]),
  messageByClientId: (senderId, clientId) =>
    one(`SELECT * FROM messages WHERE sender_id = $1 AND client_id = $2`, [senderId, clientId]),
  history: (conversationId, before, limit) => many(
    `SELECT * FROM messages WHERE conversation_id = $1 AND created_at < $2
     ORDER BY created_at DESC LIMIT $3`, [conversationId, before, limit]),
  lastMessage: (conversationId) => one(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conversationId]),
  unreadCount: async (conversationId, userId) => {
    const row = await one(
      `SELECT COUNT(*)::int AS n FROM messages
       WHERE conversation_id = $1 AND sender_id != $2
         AND created_at > COALESCE(
           (SELECT created_at FROM messages WHERE id = (
              SELECT last_read_message_id FROM members
              WHERE conversation_id = $1 AND user_id = $2)), 0)`,
      [conversationId, userId]);
    return row.n;
  },
  markRead: (messageId, conversationId, userId) =>
    run(`UPDATE members SET last_read_message_id = $1 WHERE conversation_id = $2 AND user_id = $3`,
      [messageId, conversationId, userId])
};

const publicUser = (u, onlineIds) => u && ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  avatarUrl: u.avatar_url || null,
  lastSeenAt: Number(u.last_seen_at),
  online: onlineIds ? onlineIds.has(u.id) : undefined
});

const publicMessage = (m) => m && ({
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  clientId: m.client_id,
  kind: m.kind,
  body: m.body,
  attachment: m.attachment_url
    ? { url: m.attachment_url, name: m.attachment_name, size: m.attachment_size, mime: m.attachment_mime }
    : null,
  createdAt: Number(m.created_at)
});

module.exports = { pool, init, q, publicUser, publicMessage };