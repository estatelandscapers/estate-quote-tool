const crypto = require('node:crypto');

function newId() {
  return crypto.randomUUID();
}

// Short, URL-safe, hard-to-guess token for public quote links: /q/:token
function newToken() {
  return crypto.randomBytes(18).toString('base64url'); // 24 chars, ~144 bits
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

module.exports = { newId, newToken, hashPin };
