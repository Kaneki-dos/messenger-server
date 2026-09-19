require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const auth = require('./auth');
const rest = require('./rest');
const realtime = require('./realtime');
const { init } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, at: Date.now() }));
app.use('/auth', auth.router);
app.use('/files', express.static(rest.UPLOAD_DIR, { maxAge: '7d' }));
app.use('/', rest.router);

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = status === 413
    ? 'That file is over the 25 MB limit.'
    : status === 500 ? 'Something broke on the server.' : err.message;
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
});

async function main() {
  await init();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' }, pingInterval: 20000, pingTimeout: 25000 });
  realtime.attach(io);

  const PORT = Number(process.env.PORT) || 4000;
  server.listen(PORT, () => console.log(`Messenger API listening on http://localhost:${PORT}`));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});