const jwt = require("jsonwebtoken");
const { promisePool } = require("../db/dbConfig");

module.exports = function (io) {

  if (!promisePool) {
    console.error("❌ DB not connected");
    return;
  }

  console.log("🎮 LuckyFive Engine Started");
  // CONFIG
  const ROUND_DURATION_MS = 30000; // 30s
  const FREEZE_OFFSET_MS = 25000;  // freeze at 25s
  const RESULT_OFFSET_MS = 27000;  // announce result at 27s
  const WIN_MULTIPLIER = 5;        // payout multiplier (configurable)

  // In-memory round object
  let currentRound = createRound();

  // map socketId -> session info (userId, balance cached)
  const userSessions = new Map();

  // Helper: create new in-memory round
  function createRound() {
    const now = Date.now();
    return {
      id: null, // DB auto-increment id will be filled when persisted
      startTime: now,
      freezeTime: now + FREEZE_OFFSET_MS,
      resultTime: now + RESULT_OFFSET_MS,
      endTime: now + ROUND_DURATION_MS,
      winningLine: null,
      bets: new Map(),       // socketId -> { line1: n, ... }
      finalBets: new Map(),  // socketId -> snapshot saved on submit_final_bets
      persistedRoundId: null // DB id of game_rounds row (if persisted)
    };
  }

  // Persist a new round row (start_time). We'll insert at round start
  async function persistRoundStart(round) {
    try {
      const conn = await promisePool.getConnection();
      try {
        const startDt = new Date(round.startTime);
        const [res] = await conn.execute(
          'INSERT INTO game_rounds (start_time) VALUES (?)',
          [new Date(round.startTime)]
        );
        round.persistedRoundId = res.insertId;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error("[DB] persistRoundStart error:", err);
    }
  }

  // Update round with winning_line and end_time
  async function persistRoundResult(round) {
    if (!round.persistedRoundId) {
      // fallback: insert if not persisted
      try {
        const conn = await promisePool.getConnection();
        try {
          const [res] = await conn.execute(
            'INSERT INTO game_rounds (start_time, end_time, winning_line) VALUES (?,?,?)',
            [new Date(round.startTime), new Date(round.endTime), round.winningLine]
          );
          round.persistedRoundId = res.insertId;
        } finally { conn.release(); }
      } catch (err) {
        console.error("[DB] persistRoundResult insert fallback error:", err);
      }
      return;
    }

    try {
      const conn = await promisePool.getConnection();
      try {
        await conn.execute(
          'UPDATE game_rounds SET end_time = ?, winning_line = ? WHERE id = ?',
          [new Date(round.endTime), round.winningLine, round.persistedRoundId]
        );
      } finally { conn.release(); }
    } catch (err) {
      console.error("[DB] persistRoundResult update error:", err);
    }
  }

  // Schedule engine loop: check every 500ms
  setInterval(() => {
    const now = Date.now();

    // If we just started this round (first tick after creation), persist row and emit start_round
    if (!currentRound._startAnnounced && now >= currentRound.startTime) {
      currentRound._startAnnounced = true;
      // persist round start (non-blocking)
      persistRoundStart(currentRound).catch(e => console.error(e));

      // broadcast start_round
      io.emit('start_round', {
        roundId: currentRound.startTime, // use startTime as ephemeral id for clients to refer
        serverTime: Date.now(),
        freezeIn: Math.max(0, currentRound.freezeTime - Date.now()),
        resultIn: Math.max(0, currentRound.resultTime - Date.now())
      });
      console.log(`[GAME] start_round emitted (startTime=${currentRound.startTime})`);
    }

    // Freeze bets
    if (!currentRound._freezeAnnounced && now >= currentRound.freezeTime) {
      currentRound._freezeAnnounced = true;
      io.emit('freeze_bets', {
        roundId: currentRound.startTime,
        serverTime: Date.now()
      });
      console.log(`[GAME] freeze_bets emitted (startTime=${currentRound.startTime})`);
      // At this point, server expects clients to emit submit_final_bets
    }

    // Result time
    if (!currentRound.winningLine && now >= currentRound.resultTime) {
      // compute winner
      const winningLine = Math.floor(Math.random() * 5) + 1;
      currentRound.winningLine = winningLine;

      // Persist result and compute payouts (DB operations)
      (async () => {
        try {
          // persist round result row
          await persistRoundResult(currentRound);
          console.log(`[GAME] persisted round result id=${currentRound.persistedRoundId} winner=${winningLine}`);

          // Process payouts for each final bet snapshot
          // For each socketId in finalBets map
          for (const [socketId, snapshot] of currentRound.finalBets.entries()) {
            try {
              // snapshot: { userId, bets: {line1: n,...}, totalAmount }
              const userId = snapshot.userId;
              if (!userId) continue;

              // compute user win for this round
              const userBets = snapshot.bets || {};
              const betOnWinningLine = Number(userBets[`line${winningLine}`] || 0);
              const winAmount = betOnWinningLine * WIN_MULTIPLIER;

              // process DB transaction: credit wins (if any)
              const conn = await promisePool.getConnection();
              try {
                await conn.beginTransaction();

                if (winAmount > 0) {
                  // credit user's balance
                  await conn.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [winAmount, userId]
                  );
                  // record win transaction
                  await conn.execute(
                    'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
                    [userId, winAmount, 'win', `Win on line ${winningLine} round ${currentRound.persistedRoundId}`]
                  );
                }

                // record result snapshot in transactions (we already recorded bets when submitted)
                await conn.commit();
              } catch (txErr) {
                await conn.rollback();
                console.error("[DB] payout tx error for user", userId, txErr);
              } finally {
                conn.release();
              }

              // notify user (if connected)
              // find socket(s) belonging to this user
              for (const [sId, session] of userSessions.entries()) {
                if (session.userId === userId) {
                  // send round_result to the client with winAmount and new balance
                  // get updated balance
                  const [rows] = await promisePool.execute('SELECT balance FROM users WHERE id = ?', [userId]);
                  const newBalance = rows[0]?.balance ?? session.balance;

                  io.to(sId).emit('round_result', {
                    roundId: currentRound.persistedRoundId || currentRound.startTime,
                    winningLine,
                    winAmount,
                    newBalance,
                    serverTime: Date.now()
                  });

                  // update server cached balance
                  session.balance = newBalance;
                  break;
                }
              }
            } catch (errInner) {
              console.error("[GAME] Error processing payout for snapshot", errInner);
            }
          }

          console.log(`[GAME] round_result emitted for startTime=${currentRound.startTime} winningLine=${winningLine}`);
        } catch (err) {
          console.error("[GAME] Error in round result processing:", err);
        } finally {
          // round is complete -> schedule fresh round
          // create a new in-memory round and keep the previous for a moment
          const oldRound = currentRound;
          currentRound = createRound();
          console.log('[GAME] new round scheduled');
        }
      })();
    }

    // If endTime passed we already created a new round above; loop continues
  }, 500);

  // ---------- SOCKET HANDLERS ----------
  io.on('connection', (socket) => {
    console.log('[SOCKET] connected', socket.id);

    // AUTH: client sends token to authenticate and receive userId
    socket.on('authenticate', async (token) => {
      try {
        if (!token) {
          socket.emit('auth_error', { error: 'No token' });
          return;
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;

        // fetch user balance
        const [rows] = await promisePool.execute('SELECT id, username, balance FROM users WHERE id = ?', [userId]);
        if (!rows.length) {
          socket.emit('auth_error', { error: 'User not found' });
          return;
        }
        const user = rows[0];
        // store session
        userSessions.set(socket.id, {
          userId: user.id,
          username: user.username,
          balance: Number(user.balance)
        });

        socket.emit('authenticated', { userId: user.id, balance: Number(user.balance) });
        console.log(`[AUTH] socket ${socket.id} authenticated as user ${user.id}`);
      } catch (err) {
        console.error('[AUTH] token error:', err);
        socket.emit('auth_error', { error: 'Invalid token' });
      }
    });

    // join_game - client requests current state
    socket.on('join_game', () => {
      // respond with current state (use startTime as round id for client)
      socket.emit('current_state', {
        roundId: currentRound.startTime,
        serverTime: Date.now(),
        freezeIn: Math.max(0, currentRound.freezeTime - Date.now()),
        resultIn: Math.max(0, currentRound.resultTime - Date.now()),
        isBettingOpen: !currentRound._freezeAnnounced
      });
      console.log(`[SOCKET] join_game responded to ${socket.id}`);
    });

    // Incremental bets (client sends each +/−). We only keep in-memory until freeze
    socket.on('place_bet', (data) => {
      try {
        const session = userSessions.get(socket.id);
        // if user not authenticated, ignore (or you can allow guest)
        const userId = session?.userId ?? null;

        // initialize map entry if missing
        if (!currentRound.bets.has(socket.id)) {
          currentRound.bets.set(socket.id, { line1: 0, line2: 0, line3: 0, line4: 0, line5: 0 });
        }
        const betsObj = currentRound.bets.get(socket.id);

        // Expect data.shape: { line: 'line1', amount: number, operation: 'add'|'remove' }
        const { line, amount, operation } = data;
        if (operation === 'add') {
          betsObj[line] = (betsObj[line] || 0) + Number(amount || 0);
        } else if (operation === 'remove') {
          betsObj[line] = 0; // remove/reset
        }

        currentRound.bets.set(socket.id, betsObj);

        console.log(`[SOCKET] place_bet updated for socket ${socket.id} ->`, betsObj);
        socket.emit('place_bet_ack', { success: true, bets: betsObj });
      } catch (err) {
        console.error('[SOCKET] place_bet error', err);
        socket.emit('place_bet_ack', { success: false, error: 'server error' });
      }
    });

    // FINAL BET SUBMISSION (called by client when freeze occurs)
    socket.on('submit_final_bets', async (payload) => {
      // payload: { roundId, bets: {line1:..}, totalAmount, clientTime }
      const session = userSessions.get(socket.id);
      if (!session || !session.userId) {
        socket.emit('bet_error', { message: 'Not authenticated' });
        return;
      }
      const userId = session.userId;

      // Validate round (ensure still the same round)
      // We use startTime as client roundId
      if (String(payload.roundId) !== String(currentRound.startTime)) {
        socket.emit('bet_error', { message: 'Round mismatch' });
        return;
      }

      const bets = payload.bets || {};
      const totalAmount = Number(payload.totalAmount || Object.values(bets).reduce((s, v) => s + Number(v || 0), 0));

      // DB transaction: verify and deduct balance, insert transactions and player_bets
      let conn;
      try {
        conn = await promisePool.getConnection();
        await conn.beginTransaction();

        // get current balance FOR UPDATE
        const [rows] = await conn.execute('SELECT balance FROM users WHERE id = ? FOR UPDATE', [userId]);
        if (!rows.length) {
          await conn.rollback();
          socket.emit('bet_error', { message: 'User not found' });
          return;
        }
        const currentBalance = Number(rows[0].balance);

        if (currentBalance < totalAmount) {
          await conn.rollback();
          socket.emit('bet_error', { message: 'Insufficient balance' });
          return;
        }

        // Deduct balance
        await conn.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [totalAmount, userId]);

        // Insert transaction row(s) for each non-zero bet (type='bet')
        for (const [line, amt] of Object.entries(bets)) {
          const amountNum = Number(amt || 0);
          if (amountNum <= 0) continue;

          await conn.execute(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
            [userId, amountNum, 'bet', `Bet ${line} on round ${currentRound.startTime}`]
          );

          // insert into player_bets table
          await conn.execute(
            'INSERT INTO player_bets (round_id, user_id, line, amount) VALUES (?, ?, ?, ?)',
            [currentRound.persistedRoundId || null, userId, line, amountNum]
          );
        }

        await conn.commit();
        conn.release();
        conn = null;

        // store final snapshot in memory (for payout when winning)
        currentRound.finalBets.set(socket.id, {
          userId,
          bets,
          totalAmount
        });

        // Update server-cached user session balance (subtract now)
        session.balance = currentBalance - totalAmount;

        // ack to client
        socket.emit('bet_accepted', { success: true, newBalance: session.balance });
        console.log(`[DB] final bets accepted for user ${userId}, amount ${totalAmount}`);

      } catch (err) {
        if (conn) {
          try { await conn.rollback(); conn.release(); } catch (e) {}
        }
        console.error('[DB] submit_final_bets error:', err);
        socket.emit('bet_error', { message: 'Server DB error' });
      }
    });

    // Disconnect cleanup
    socket.on('disconnect', () => {
      console.log('[SOCKET] disconnected', socket.id);
      userSessions.delete(socket.id);
    });
  });

}; // end module.exports
