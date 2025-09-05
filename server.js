/**
 * Multi-room real-time chat server using Socket.IO
 * - Supports join/leave rooms
 * - Broadcasts messages to room
 * - Typing indicators
 * - In-memory bounded message history per room
 * - Optional Redis adapter when REDIS_URL is provided (for scaling)
 *
 * Usage:
 *   - set REDIS_URL to enable redis adapter (optional)
 *   - set PORT (default 3000)
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // optional test client

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e6,
});

// Optional: Redis adapter for multi-instance scaling (set REDIS_URL env var)
if (process.env.REDIS_URL) {
  try {
    const { createAdapter } = require("@socket.io/redis-adapter");
    const { createClient } = require("redis");
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      console.log("Redis adapter connected");
    }).catch(err => {
      console.error("Redis adapter failed to connect:", err);
    });
  } catch (err) {
    console.warn("Redis adapter not configured. To enable, install redis and set REDIS_URL.");
  }
}

// Simple in-memory bounded history per room
const ROOM_HISTORY_LIMIT = 100;
const roomHistory = new Map(); // room -> [{id, author, text, ts}]

function pushRoomMessage(room, msg) {
  if (!roomHistory.has(room)) roomHistory.set(room, []);
  const arr = roomHistory.get(room);
  arr.push(msg);
  if (arr.length > ROOM_HISTORY_LIMIT) arr.shift();
}

// Basic handshake checking: accept username in handshake auth
io.use((socket, next) => {
  const username = socket.handshake.auth && socket.handshake.auth.username;
  if (!username || typeof username !== "string" || username.trim() === "") {
    return next(new Error("invalid username"));
  }
  socket.data.username = username.trim();
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.username;
  console.log(`connected: ${user} (id=${socket.id})`);

  // send list of rooms this socket is in (initially none except socket.id)
  socket.emit("connected", { id: socket.id, username: user });

  // Join a room, returns room state (member count, recent history)
  socket.on("join", async (room, cb) => {
    try {
      if (!room || typeof room !== "string") return cb && cb({ ok: false, error: "room required" });
      socket.join(room);
      // Notify others in room
      socket.to(room).emit("user_joined", { user, room });
      // compute member count
      const socketsInRoom = await io.in(room).allSockets();
      const memberCount = socketsInRoom.size;
      const history = roomHistory.get(room) || [];
      cb && cb({ ok: true, room, memberCount, history });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  // Leave a room
  socket.on("leave", async (room, cb) => {
    try {
      await socket.leave(room);
      socket.to(room).emit("user_left", { user, room });
      const socketsInRoom = await io.in(room).allSockets();
      cb && cb({ ok: true, room, memberCount: socketsInRoom.size });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  // Send message to a room
  socket.on("message", async (payload, cb) => {
    try {
      // payload: { room, text, meta? }
      const { room, text, meta } = payload || {};
      if (!room || !text) return cb && cb({ ok: false, error: "room & text required" });
      const msg = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        room,
        text,
        author: user,
        meta: meta || null,
        ts: new Date().toISOString(),
      };
      pushRoomMessage(room, msg);
      // broadcast to room (including sender)
      io.in(room).emit("message", msg);
      cb && cb({ ok: true, id: msg.id });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  // Typing indicator
  socket.on("typing", ({ room, isTyping }) => {
    if (!room) return;
    socket.to(room).emit("typing", { user, room, isTyping: !!isTyping });
  });

  // Request history (if client didn't on join)
  socket.on("history", (room, cb) => {
    const history = roomHistory.get(room) || [];
    cb && cb({ ok: true, room, history });
  });

  // Disconnect handling
  socket.on("disconnect", (reason) => {
    console.log(`disconnected: ${user} (id=${socket.id}) reason=${reason}`);
    // notify rooms the socket was in (socket.rooms includes socket.id)
    for (const room of socket.rooms) {
      if (room === socket.id) continue;
      socket.to(room).emit("user_left", { user, room });
    }
  });
});

// Health
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

const PORT = parseInt(process.env.PORT || "3000", 10);
server.listen(PORT, () => console.log(`Chat server listening on http://localhost:${PORT}`));
