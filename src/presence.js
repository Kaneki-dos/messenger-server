// Tracks how many live sockets each user has. A user is online while the count > 0,
// so a phone with two tabs/devices does not flicker offline when one disconnects.
const counts = new Map();

const online = (userId) => (counts.get(userId) || 0) > 0;
const onlineIds = () => new Set([...counts.keys()].filter(online));

function connect(userId) {
  const next = (counts.get(userId) || 0) + 1;
  counts.set(userId, next);
  return next === 1; // became online
}

function disconnect(userId) {
  const next = (counts.get(userId) || 0) - 1;
  if (next <= 0) counts.delete(userId);
  else counts.set(userId, next);
  return next <= 0; // went offline
}

module.exports = { connect, disconnect, online, onlineIds };
