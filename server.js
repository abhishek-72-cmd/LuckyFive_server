const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');

// DB
const { pool: promisePool, testConnection } = require('./db/dbConfig');

// Routes
const authRoutes = require('./controller/auth');

// ======================= APP SETUP =======================
const PORT = process.env.PORT || 5000;
const app = express();
const server = http.createServer(app);



// Socket.io setup
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));
app.use(express.json());
app.use('/api/auth', authRoutes);

// ==================== GAME STATE ====================

class GameRound {
  constructor() {
    this.id = `R${Date.now()}`;
    this.matrix = this.generateMatrix();
    this.startTime = Date.now();
    this.freezeTime = this.startTime + 25000; // Freeze at 25s
    this.endTime = this.startTime + 30000; // End at 30s
    this.nextRoundTime = this.startTime + 33000; // Next round at 33s
    this.isBettingOpen = true;
    this.winningLine = null;
    this.finalBets = new Map(); // userId -> {bets, totalAmount}
  }

  generateMatrix() {
    const matrix = [];
    for (let col = 0; col < 5; col++) {
      const columnNumbers = [];
      for (let row = 0; row < 5; row++) {
        columnNumbers.push(Math.floor(Math.random() * 99) + 1);
      }
      matrix.push(columnNumbers);
    }
    return matrix;
  }

  getGameState() {
    const now = Date.now();
    const timeRemaining = Math.max(0, Math.floor((this.freezeTime - now) / 1000));
    
    return {
      roundId: this.id,
      matrix: this.matrix,
      startTime: this.startTime,
      freezeTime: this.freezeTime,
      timeRemaining: timeRemaining,
      isBettingOpen: this.isBettingOpen,
      winningLine: this.winningLine
    };
  }

  getTimeUntilNextEvent() {
    const now = Date.now();
    return {
      untilFreeze: Math.max(0, this.freezeTime - now),
      untilWinner: Math.max(0, (this.freezeTime + 2000) - now), // Winner at 27s (freeze + 2s)
      untilRoundEnd: Math.max(0, this.endTime - now),
      untilNextRound: Math.max(0, this.nextRoundTime - now)
    };
  }
}

let currentRound = new GameRound();
let userSessions = new Map(); // socketId -> {userId, balance, username, pendingBets}
let gameInterval = null;

// ==================== HTTP APIs ====================

// // Time sync endpoint
// app.get('/api/time-sync', (req, res) => {
//   res.json({ serverTime: Date.now() });
// });

// // Current round info for late joiners
// app.get('/api/current-round', (req, res) => {
//   res.json({
//     currentRound: currentRound.getGameState(),
//     serverTime: Date.now()
//   });
// });

// Get user balance
app.get('/api/get-balance', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [users] = await promisePool.execute(
      'SELECT balance FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ balance: users[0].balance });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ==================== GAME ENGINE ====================

function startGameEngine() {
  if (gameInterval) clearInterval(gameInterval);
  
  console.log('🎮 Starting game engine with corrected timing...');
  console.log('⏰ Round Duration: 30s | Betting: 0-25s | Freeze: 25s | Winner: 27s | Next Round: 33s');
  
  broadcastRoundStart();
  
  gameInterval = setInterval(() => {
    const times = currentRound.getTimeUntilNextEvent();
    const now = Date.now();

    // Check for betting freeze (25s)
    if (currentRound.isBettingOpen && now >= currentRound.freezeTime) {
      freezeBets();
    }
    
    // Check for winner announcement (27s - freeze + 2s)
    if (!currentRound.winningLine && now >= currentRound.freezeTime + 2000) {
      announceWinner();
    }
    
    // Check for round end (30s)
    if (now >= currentRound.endTime) {
      processRoundResults();
    }
    
    // Check for next round start (33s)
    if (now >= currentRound.nextRoundTime) {
      startNewRound();
    }

    // Broadcast timer update every second
    const gameState = currentRound.getGameState();
    io.emit('timer_update', {
      timeRemaining: gameState.timeRemaining,
      isBettingOpen: gameState.isBettingOpen
    });

  }, 1000);
}

function broadcastRoundStart() {
  const gameState = currentRound.getGameState();
  io.emit('start_bet', gameState);
  console.log(`🎯 Round ${currentRound.id} started`);
  console.log(`⏰ Freeze at: ${new Date(currentRound.freezeTime).toISOString()}`);
  console.log(`🎰 Winner at: ${new Date(currentRound.freezeTime + 2000).toISOString()}`);
}

function freezeBets() {
  currentRound.isBettingOpen = false;
  io.emit('freeze_bets', { 
    message: 'Betting closed - submitting final bets',
    roundId: currentRound.id
  });
  console.log('🔒 Betting frozen at 25s');
  
  // Give clients 2 seconds to submit final bets (25-27s)
  setTimeout(() => {
    processFinalBets();
  }, 2000);
}

function processFinalBets() {
  console.log(`📦 Processing ${currentRound.finalBets.size} final bet submissions`);
  // Bets are already stored in currentRound.finalBets during the 25-27s window
}

function announceWinner() {
  const winningLine = Math.floor(Math.random() * 5) + 1;
  currentRound.winningLine = winningLine;
  
  io.emit('announce_winner', { 
    winningLine,
    roundId: currentRound.id
  });
  console.log(`🎉 Winner announced at 27s: Line ${winningLine}`);
}

async function processRoundResults() {
  console.log(`💰 Processing round results for ${currentRound.id}`);
  
  for (const [userId, betData] of currentRound.finalBets) {
    const userBetOnWinningLine = betData.bets[`line${currentRound.winningLine}`] || 0;
    const winAmount = userBetOnWinningLine * 2;

    if (winAmount > 0) {
      try {
        const connection = await promisePool.getConnection();
        await connection.beginTransaction();

        // Update balance
        await connection.execute(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [winAmount, userId]
        );

        // Record transaction
        await connection.execute(
          'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
          [userId, winAmount, 'win', `Won on line ${currentRound.winningLine}`]
        );

        // Record game round
        await connection.execute(
          'INSERT INTO game_rounds (round_id, start_time, end_time, winning_line) VALUES (?, NOW(), NOW(), ?)',
          [currentRound.id, currentRound.winningLine]
        );

        // Get updated balance
        const [users] = await connection.execute(
          'SELECT balance FROM users WHERE id = ?',
          [userId]
        );

        await connection.commit();
        connection.release();

        // Find socket for this user and notify
        for (const [socketId, userSession] of userSessions) {
          if (userSession.userId === userId) {
            io.to(socketId).emit('round_end', { 
              roundId: currentRound.id,
              winningLine: currentRound.winningLine,
              winAmount,
              newBalance: users[0].balance
            });
            userSession.balance = users[0].balance;
            break;
          }
        }

      } catch (error) {
        console.error(`Error processing winnings for user ${userId}:`, error);
      }
    } else {
      // Notify users who didn't win
      for (const [socketId, userSession] of userSessions) {
        if (userSession.userId === userId) {
          io.to(socketId).emit('round_end', { 
            roundId: currentRound.id,
            winningLine: currentRound.winningLine,
            winAmount: 0,
            newBalance: userSession.balance
          });
          break;
        }
      }
    }
  }
  
  console.log(`✅ Round ${currentRound.id} completed`);
}

function startNewRound() {
  currentRound = new GameRound();
  console.log('🔄 Starting new round at 33s');
  broadcastRoundStart();
}

// ==================== SOCKET HANDLERS ====================

io.on('connection', (socket) => {
  console.log('🔌 User connected - Socket ID:', socket.id);


   socket.on ('join_game', (data)=>{
     console.log(`🎮 User joined game - Socket ID: ${socket.id}`, data);
     socket.emit('current_state', {
      server_time: Date.now(),
    round_id: currentRound.id,      // use your currentRound
    timeRemaining: currentRound.getGameState().timeRemaining,
    isBettingOpen: currentRound.isBettingOpen
     })
    })

    socket.on('place_bet',(betData)=>{
       console.log(`[SERVER] place_bet from ${socket.id}:`, betData);
  // For phase 1 just ack
  socket.emit('place_bet_ack', { success: true, received: betData });
    })

  // Send current game state to new connection
  socket.emit('start_bet', currentRound.getGameState());

  socket.on('authenticate', async (token) => {
    console.log('🔐 Authentication request received');
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('✅ Token verified - User ID:', decoded.userId);

      const [users] = await promisePool.execute(
        'SELECT id, username, email, balance FROM users WHERE id = ?',
        [decoded.userId]
      );

      if (users.length === 0) {
        console.log('❌ User not found in database');
        socket.emit('auth_error', { error: 'User not found' });
        return;
      }

      const user = users[0];
      socket.userId = user.id;
      
      userSessions.set(socket.id, {
        userId: user.id,
        balance: user.balance,
        username: user.username,
        pendingBets: {} // Store bets locally until freeze
      });

      console.log(`✅ User ${user.username} authenticated successfully`);
      console.log(`💰 User balance: ${user.balance}`);

      socket.emit('user_data', {
        balance: user.balance,
        userId: user.id
      });

    } catch (error) {
      console.error('❌ Authentication error:', error.message);
      socket.emit('auth_error', { error: 'Authentication failed' });
    }
  });

  // Client updates pending bets locally and verifies balance via HTTP API
  socket.on('update_pending_bet', async (data) => {
    if (!socket.userId) {
      socket.emit('bet_error', { error: 'Not authenticated' });
      return;
    }

    if (!currentRound.isBettingOpen) {
      socket.emit('bet_error', { error: 'Betting is closed' });
      return;
    }

    const { lineNumber, amount, operation } = data; // operation: 'add' or 'remove'
    const userSession = userSessions.get(socket.id);

    try {
      // Verify balance via HTTP API for accuracy
      const [users] = await promisePool.execute(
        'SELECT balance FROM users WHERE id = ?',
        [socket.userId]
      );

      const currentBalance = users[0].balance;
      
      if (operation === 'add' && currentBalance < amount) {
        socket.emit('bet_error', { error: 'Insufficient balance' });
        return;
      }

      // Update pending bets locally
      if (!userSession.pendingBets[`line${lineNumber}`]) {
        userSession.pendingBets[`line${lineNumber}`] = 0;
      }

      if (operation === 'add') {
        userSession.pendingBets[`line${lineNumber}`] += amount;
      } else {
        userSession.pendingBets[`line${lineNumber}`] = Math.max(0, userSession.pendingBets[`line${lineNumber}`] - amount);
      }

      // Update session balance (for UI only - real balance checked via API)
      userSession.balance = currentBalance;
      
      socket.emit('pending_bet_updated', {
        lineNumber,
        amount: userSession.pendingBets[`line${lineNumber}`],
        newBalance: currentBalance
      });

    } catch (error) {
      console.error('Update pending bet error:', error);
      socket.emit('bet_error', { error: 'Failed to update bet' });
    }
  });

  // Submit final bets during 25-27s window
  socket.on('submit_final_bets', async (data) => {
    if (!socket.userId) {
      socket.emit('bet_error', { error: 'Not authenticated' });
      return;
    }

    if (currentRound.isBettingOpen) {
      socket.emit('bet_error', { error: 'Betting still open' });
      return;
    }

    const userSession = userSessions.get(socket.id);
    const pendingBets = userSession.pendingBets;
    const totalAmount = Object.values(pendingBets).reduce((sum, bet) => sum + bet, 0);

    if (totalAmount === 0) {
      socket.emit('final_bets_submitted', { message: 'No bets to submit' });
      return;
    }

    try {
      const connection = await promisePool.getConnection();
      await connection.beginTransaction();

      // Verify and deduct balance
      const [users] = await connection.execute(
        'SELECT balance FROM users WHERE id = ? FOR UPDATE',
        [socket.userId]
      );

      if (users[0].balance < totalAmount) {
        await connection.rollback();
        connection.release();
        socket.emit('bet_error', { error: 'Insufficient balance for final bets' });
        return;
      }

      // Deduct total bet amount
      await connection.execute(
        'UPDATE users SET balance = balance - ? WHERE id = ?',
        [totalAmount, socket.userId]
      );

      // Record transactions for each bet
      for (const [line, amount] of Object.entries(pendingBets)) {
        if (amount > 0) {
          await connection.execute(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
            [socket.userId, amount, 'bet', `Bet on ${line}`]
          );
        }
      }

      await connection.commit();
      connection.release();

      // Store final bets in game round
      currentRound.finalBets.set(socket.userId, {
        bets: { ...pendingBets },
        totalAmount
      });

      // Update session
      userSession.balance -= totalAmount;
      userSession.pendingBets = {};

      socket.emit('final_bets_submitted', {
        success: true,
        bets: pendingBets,
        newBalance: userSession.balance
      });

      console.log(`✅ Final bets submitted for user ${socket.userId}:`, pendingBets);

    } catch (error) {
      console.error('Submit final bets error:', error);
      socket.emit('bet_error', { error: 'Failed to submit final bets' });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('❌ User disconnected - Socket ID:', socket.id);
    console.log('📝 Disconnect reason:', reason);
    userSessions.delete(socket.id);
  });
});

// ==================== SERVER STARTUP ====================

const startServer = async () => {
  try {
    const [rows] = await promisePool.execute('SELECT 1 + 1 AS solution');
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    process.exit(1);
  }

  startGameEngine();

  console.log(`\n🎰 LuckyFive Game Server Started!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Socket.IO: ws://localhost:${PORT}`);
  console.log(`⏰ Round Duration: 30 seconds`);
  console.log(`🎯 Betting Window: 0-25 seconds`);
  console.log(`❄️ Freeze at: 25 seconds`);
  console.log(`🎉 Winner at: 27 seconds`);
  console.log(`💰 Results at: 30 seconds`);
  console.log(`🔄 Next Round: 33 seconds`);
  console.log(`=========================================`);
};

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  startServer();
});
