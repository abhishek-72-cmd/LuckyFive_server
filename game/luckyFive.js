// ./game/luckyFive.js
const jwt = require("jsonwebtoken");

// Export engine as a function taking io and using existing promisePool from dbConfig
// Usage: const luckyEngine = require('./game/luckyFive'); luckyEngine(io);
module.exports = function (io) {
  const { promisePool } = require("../db/dbConfig");

  if (!promisePool) {
    console.error("❌ DB not connected - game engine aborted");
    return;
  }

  const nowIso = () => new Date().toISOString();
  const log = (...args) => console.log(`[GAME ${nowIso()}]`, ...args);

  // ---------------- CONFIG (single place to change server timing) ----------------
  const DEFAULT_TIMER = 30 * 1000;     // 30s in ms (used conceptually)
  const FREEZE_OFFSET_MS = 25_000;     // freeze at 25s
  const RESULT_OFFSET_MS = 30_000;     // reveal at 30s
  const ROUND_DURATION_MS = 40_000;    // next start at start + 40s
  const WIN_MULTIPLIER = 5;
  // ------------------------------------------------------------------------------

  // In-memory round object and timers for scheduled tasks
  let currentRound = createRound(Date.now());
  // timers for currentRound: will hold setTimeout ids
  currentRound.timers = {};

  // session map socketId -> { userId, username, balance }
  const userSessions = new Map();

  // ---------- Helper: create a round object for a given startTime ----------
  function createRound(startTime) {
    const s = startTime || Date.now();
    return {
      startTime: s,
      freezeTime: s + FREEZE_OFFSET_MS,
      resultTime: s + RESULT_OFFSET_MS,
      endTime: s + ROUND_DURATION_MS,
      persistedRoundId: null,
      winningLine: null,
      bets: new Map(),       // socketId -> incremental bets while betting open
      finalBets: new Map(),  // socketId -> snapshot accepted at freeze/submit_final_bets
      timers: {}
    };
  }

  // ---------- DB helpers ----------
  async function persistRoundStart(round) {
    try {
      const conn = await promisePool.getConnection();
      try {
        const [res] = await conn.execute(
          "INSERT INTO game_rounds (start_time) VALUES (?)",
          [new Date(round.startTime)]
        );
        round.persistedRoundId = res.insertId;
        log("persistRoundStart -> id=", res.insertId);
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error("[DB] persistRoundStart error:", err);
    }
  }

  async function persistRoundResult(round) {
    try {
      if (!round.persistedRoundId) {
        // fallback insert
        const conn = await promisePool.getConnection();
        try {
          const [res] = await conn.execute(
            "INSERT INTO game_rounds (start_time, end_time, winning_line) VALUES (?,?,?)",
            [new Date(round.startTime), new Date(round.endTime), round.winningLine]
          );
          round.persistedRoundId = res.insertId;
          log("persistRoundResult fallback insert -> id=", res.insertId);
        } finally {
          conn.release();
        }
        return;
      }

      const conn = await promisePool.getConnection();
      try {
        await conn.execute(
          "UPDATE game_rounds SET end_time = ?, winning_line = ? WHERE id = ?",
          [new Date(round.endTime), round.winningLine, round.persistedRoundId]
        );
        log("persistRoundResult update done -> id=", round.persistedRoundId);
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error("[DB] persistRoundResult error:", err);
    }
  }

  // ---------- Scheduling helpers ----------
  function scheduleRoundTimers(round) {
    const now = Date.now();

    // start_round should be emitted at round.startTime
    const startDelay = Math.max(0, round.startTime - now);
    round.timers.start = setTimeout(() => {
      try {
        emitStartRound(round);
      } catch (e) {
        console.error("[GAME] emitStartRound error", e);
      }
    }, startDelay);

    // freeze_bets at freezeTime
    const freezeDelay = Math.max(0, round.freezeTime - now);
    round.timers.freeze = setTimeout(() => {
      try {
        emitFreezeBets(round);
      } catch (e) {
        console.error("[GAME] emitFreezeBets error", e);
      }
    }, freezeDelay);

    // result at resultTime
    const resultDelay = Math.max(0, round.resultTime - now);
    round.timers.result = setTimeout(() => {
      try {
        emitRoundResultAndProcess(round);
      } catch (e) {
        console.error("[GAME] emitRoundResultAndProcess error", e);
      }
    }, resultDelay);

    log("Scheduled timers", {
      startIn_ms: startDelay,
      freezeIn_ms: freezeDelay,
      resultIn_ms: resultDelay,
      roundStart: new Date(round.startTime).toISOString()
    });
  }

  function clearRoundTimers(round) {
    if (!round || !round.timers) return;
    for (const k of Object.keys(round.timers)) {
      try { clearTimeout(round.timers[k]); } catch (e) {}
    }
    round.timers = {};
  }

  // ---------- Emits ----------
  async function emitStartRound(round) {
    // persist row (non-blocking)
    persistRoundStart(round).catch(err => console.error(err));

    io.emit("start_round", {
      roundId: round.startTime,
      serverTime: Date.now(),
      freezeIn: Math.max(0, round.freezeTime - Date.now()),
      resultIn: Math.max(0, round.resultTime - Date.now())
    });
    log("start_round emitted", { roundId: round.startTime });
  }

  function emitFreezeBets(round) {
    io.emit("freeze_bets", {
      roundId: round.startTime,
      serverTime: Date.now()
    });
    log("freeze_bets emitted", { roundId: round.startTime });
    // server expects clients to call submit_final_bets which we handle in socket handler
  }

  async function emitRoundResultAndProcess(round) {
    // choose winner (1..5)
    try {
      round.winningLine = Math.floor(Math.random() * 5) + 1;
      // persist & compute payouts
      await persistRoundResult(round);
      log("persisted round result", { id: round.persistedRoundId, winner: round.winningLine });

      // process payouts for every finalBets snapshot
      for (const [socketId, snapshot] of round.finalBets.entries()) {
        try {
          const userId = snapshot.userId;
          if (!userId) continue;

          const userBets = snapshot.bets || {};
          const betOnWinningLine = Number(userBets[`line${round.winningLine}`] || 0);
          const winAmount = betOnWinningLine * WIN_MULTIPLIER;

          // process DB transaction per-user (award wins)
          const conn = await promisePool.getConnection();
          try {
            await conn.beginTransaction();

            if (winAmount > 0) {
              await conn.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [winAmount, userId]);
              await conn.execute(
                "INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)",
                [userId, winAmount, "win", `Win on line ${round.winningLine} round ${round.persistedRoundId}`]
              );
            }

            await conn.commit();
          } catch (txErr) {
            try { await conn.rollback(); } catch (e) {}
            console.error("[DB] payout tx error for user", userId, txErr);
          } finally {
            conn.release();
          }

          // emit round_result to connected sockets that belong to this user
          for (const [sId, session] of userSessions.entries()) {
            if (session.userId === userId) {
              // fetch fresh balance (best-effort)
              const [rows] = await promisePool.execute("SELECT balance FROM users WHERE id = ?", [userId]);
              const newBalance = rows[0]?.balance ?? session.balance;

              io.to(sId).emit("round_result", {
                roundId: round.persistedRoundId || round.startTime,
                winningLine: round.winningLine,
                winAmount,
                newBalance,
                serverTime: Date.now()
              });

              // update server cache
              session.balance = newBalance;
              break;
            }
          }
        } catch (innerErr) {
          console.error("[GAME] Error processing payout for snapshot", innerErr);
        }
      }

      // For any players who didn't submit finalBets (or guests), still broadcast round_result globally
      io.emit("round_result", {
        roundId: round.persistedRoundId || round.startTime,
        winningLine: round.winningLine,
        serverTime: Date.now()
      });

      log("round_result emitted", { roundId: round.startTime, winningLine: round.winningLine });
    } catch (err) {
      console.error("[GAME] Error in result processing:", err);
    } finally {
      // After processing result, schedule the next round in a deterministic way:
      // nextStart = previousStart + ROUND_DURATION_MS
      const nextStart = round.startTime + ROUND_DURATION_MS;
      // Clean up timers for completed round to avoid leaks
      clearRoundTimers(round);

      // prepare next round with deterministic startTime
      const nextRound = createRound(nextStart);
      currentRound = nextRound;
      log("scheduling next round", { nextStart: new Date(nextStart).toISOString() });
      scheduleRoundTimers(currentRound);
    }
  }

  // ---------- Socket handlers ----------
  io.on("connection", (socket) => {
    log("socket connected", socket.id);

    // authenticate using token (client sends JWT via 'authenticate' event)
    socket.on("authenticate", async (token) => {
      try {
        if (!token) {
          socket.emit("auth_error", { error: "No token" });
          return;
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId;
        const [rows] = await promisePool.execute("SELECT id, username, balance FROM users WHERE id = ?", [userId]);
        if (!rows.length) {
          socket.emit("auth_error", { error: "User not found" });
          return;
        }
        const u = rows[0];
        userSessions.set(socket.id, { userId: u.id, username: u.username, balance: Number(u.balance) });
        socket.emit("authenticated", { userId: u.id, balance: Number(u.balance) });
        log("socket authenticated", { socketId: socket.id, userId: u.id });
      } catch (err) {
        console.error("[AUTH] token error:", err);
        socket.emit("auth_error", { error: "Invalid token" });
      }
    });

    socket.on("join_game", () => {
      // reply with current state; clients should ONLY start countdown on start_round (server-driven)
      socket.emit("current_state", {
        roundId: currentRound.startTime,
        serverTime: Date.now(),
        freezeIn: Math.max(0, currentRound.freezeTime - Date.now()),
        resultIn: Math.max(0, currentRound.resultTime - Date.now()),
        isBettingOpen: !(Date.now() >= currentRound.freezeTime)
      });
      log("join_game responded to", socket.id);
    });

    // incremental place_bet while betting open (server doesn't deduct balance here until submit_final_bets)
    socket.on("place_bet", (data) => {
      try {
        const session = userSessions.get(socket.id);
        const userId = session?.userId ?? null;
        // create bets object if not present
        if (!currentRound.bets.has(socket.id)) {
          currentRound.bets.set(socket.id, { line1: 0, line2: 0, line3: 0, line4: 0, line5: 0 });
        }
        const betsObj = currentRound.bets.get(socket.id);
        const { line, amount, operation } = data || {};
        if (operation === "add") {
          betsObj[line] = (betsObj[line] || 0) + Number(amount || 0);
        } else if (operation === "remove") {
          betsObj[line] = 0;
        }
        currentRound.bets.set(socket.id, betsObj);
        socket.emit("place_bet_ack", { success: true, bets: betsObj });
        log("place_bet updated for socket", socket.id, betsObj);
      } catch (err) {
        console.error("[SOCKET] place_bet error", err);
        socket.emit("place_bet_ack", { success: false, error: "server error" });
      }
    });

    // FINAL SUBMIT: client sends snapshot at freeze_bets (server will deduct & persist)
    socket.on("submit_final_bets", async (payload) => {
      try {
        const session = userSessions.get(socket.id);
        if (!session || !session.userId) {
          socket.emit("bet_error", { message: "Not authenticated" });
          return;
        }
        const userId = session.userId;

        // payload roundId must match currentRound.startTime to accept on-time bets
        if (String(payload.roundId) !== String(currentRound.startTime)) {
          socket.emit("bet_error", { message: "Round mismatch" });
          log("submit_final_bets rejected round mismatch", { socketId: socket.id, payloadRound: payload.roundId, currentStart: currentRound.startTime });
          return;
        }

        const bets = payload.bets || {};
        const totalAmount = Number(payload.totalAmount || Object.values(bets).reduce((s, v) => s + Number(v || 0), 0));

        // DB transaction: verify balance and deduct
        const conn = await promisePool.getConnection();
        try {
          await conn.beginTransaction();
          const [rows] = await conn.execute("SELECT balance FROM users WHERE id = ? FOR UPDATE", [userId]);
          if (!rows.length) {
            await conn.rollback();
            socket.emit("bet_error", { message: "User not found" });
            return;
          }
          const currentBalance = Number(rows[0].balance);
          if (currentBalance < totalAmount) {
            await conn.rollback();
            socket.emit("bet_error", { message: "Insufficient balance" });
            return;
          }

          // deduct balance
          await conn.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [totalAmount, userId]);

          // insert transactions and player_bets
          for (const [line, amt] of Object.entries(bets)) {
            const amountNum = Number(amt || 0);
            if (amountNum <= 0) continue;
            await conn.execute("INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)", [userId, amountNum, "bet", `Bet ${line} on round ${currentRound.startTime}`]);
            await conn.execute("INSERT INTO player_bets (round_id, user_id, line, amount) VALUES (?, ?, ?, ?)", [currentRound.persistedRoundId || null, userId, line, amountNum]);
          }

          await conn.commit();

          // store final snapshot in memory (for computing payouts)
          currentRound.finalBets.set(socket.id, {
            userId,
            bets,
            totalAmount
          });

          // update session balance cache
          session.balance = currentBalance - totalAmount;

          // ack
          socket.emit("bet_accepted", { success: true, newBalance: session.balance });
          log("final bets accepted for user", userId, totalAmount);
        } catch (txErr) {
          try { await conn.rollback(); } catch (e) {}
          console.error("[DB] submit_final_bets tx error:", txErr);
          socket.emit("bet_error", { message: "Server DB error" });
        } finally {
          try { conn.release(); } catch (e) {}
        }
      } catch (err) {
        console.error("[SOCKET] submit_final_bets error", err);
        socket.emit("bet_error", { message: "Server error" });
      }
    });

    socket.on("disconnect", () => {
      log("socket disconnected", socket.id);
      userSessions.delete(socket.id);
      // do not delete bets in currentRound; user might rejoin and server persists based on finalBets
    });
  });

  // ---------- Start engine scheduling ----------
  // We want deterministic rounds at startTime, startTime + ROUND_DURATION_MS, etc.
  // If currentRound.startTime is in the past (e.g. first load), normalize to nearest upcoming start slot.
  (function bootstrap() {
    const now = Date.now();
    // if startTime is far in the past, compute a new startTime aligned to now
    if (currentRound.startTime + ROUND_DURATION_MS <= now) {
      // align to next slot
      const slotsPassed = Math.floor((now - currentRound.startTime) / ROUND_DURATION_MS) + 1;
      const newStart = currentRound.startTime + slotsPassed * ROUND_DURATION_MS;
      currentRound = createRound(newStart);
    }
    log("LuckyFive Engine Started - scheduling first round", {
      start: new Date(currentRound.startTime).toISOString(),
      freezeOffsetMs: FREEZE_OFFSET_MS,
      resultOffsetMs: RESULT_OFFSET_MS,
      roundDurationMs: ROUND_DURATION_MS
    });
    scheduleRoundTimers(currentRound);
  })();

  // ---------- Optional: debug HTTP endpoint if DEBUG_HTTP_PORT env set ----------
  // Very simple single-route HTTP server for debugging currentRound summary
  const debugPort = process.env.DEBUG_HTTP_PORT;
  if (debugPort) {
    try {
      const http = require("http");
      const debugServer = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/__debug/current_round") {
          const r = currentRound;
          const summary = {
            startTime: r.startTime,
            now: Date.now(),
            freezeTime: r.freezeTime,
            resultTime: r.resultTime,
            endTime: r.endTime,
            persistedRoundId: r.persistedRoundId,
            winningLine: r.winningLine,
            betsCount: r.bets.size,
            finalBetsCount: r.finalBets.size
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(summary));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
      debugServer.listen(Number(debugPort), () => {
        log(`Debug HTTP endpoint listening on http://localhost:${debugPort}/__debug/current_round`);
      });
    } catch (err) {
      console.error("[DEBUG] could not start debug HTTP endpoint:", err);
    }
  } else {
    log("Debug HTTP endpoint not started (set DEBUG_HTTP_PORT env to enable)");
  }
};
