// ------------ server.js -------------
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cors = require("cors");   // <-- ADD THIS
const { promisePool } = require('./db/dbConfig');
const jwt = require('jsonwebtoken');
const luckyEngine = require('./game/luckyFive');
const authRoutes = require('./controller/auth');
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// ======= ENABLE CORS FOR EXPRESS API =======
app.use(cors({
  origin: "http://localhost:5173",   // your frontend
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ======= ENABLE JSON BODY PARSER =======
app.use(express.json());

// ======= SOCKET.IO SETUP =======
const io = socketio(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  },
  transports: ["websocket", "polling"]
});

// Start Game Engine
luckyEngine(io, { promisePool, jwtLib: jwt });

// API Routes
app.use("/api/auth", authRoutes);

// Socket logs
io.on("connection", (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
console.log(`Server is running on http://localhost:${PORT}`)
});
