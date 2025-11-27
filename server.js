// server.js (final, cleaned, timing-patched)
// Usage: node server.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const socketio = require('socket.io');
const jwt = require('jsonwebtoken');

// DB config - keep your existing file (exports pool and promisePool)
const { pool, promisePool } = require('./db/dbConfig');

// Auth routes (unchanged)
const authRoutes = require('./controller/auth');

// Game engine (keeps DB integration inside engine). We will pass promisePool and jwt.
const startLuckyFive = require('./game/luckyFive');

const app = express();
app.use(cors());
app.use(express.json());

// mount auth API (same as your previous)
app.use('/api/auth', authRoutes);

// create HTTP server + socket.io
const server = http.createServer(app);

// socket.io config — keep transports + CORS like you asked
const io = socketio(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },
  transports: ['websocket', 'polling']
});

// Helpful startup logs
console.log('-----------------------------');
console.log('🌐 LuckyFive Server starting');
console.log('PORT:', process.env.PORT || 5000);
console.log('DB Host:', process.env.DB_HOST || 'localhost');
console.log('-----------------------------');

// Basic DB connectivity check (non-blocking)
(async function testDB() {
  try {
    const conn = await promisePool.getConnection();
    conn.release();
    console.log('✅ DB connection OK');
  } catch (err) {
    console.error('❌ DB connection failed (check .env / credentials):', err && err.code ? err.code : err);
  }
})();

// Start the LuckyFive game engine.
// We pass io, promisePool and jwt so engine has DB + JWT access.
// The engine file (./game/luckyFive.js) should be implemented as:
// module.exports = function(io, { promisePool, jwtLib }) { ... }
try {
  startLuckyFive(io, { promisePool, jwtLib: jwt });
  console.log('🎮 LuckyFive Engine attached');
} catch (err) {
  console.error('❌ Failed to attach LuckyFive engine:', err);
  // still continue: server will run but game engine might be broken
}

// Fallback: small socket-level logs for connection (keeps your previous behavior)
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] Disconnected: ${socket.id} (${reason})`);
  });
});

// Start HTTP server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
