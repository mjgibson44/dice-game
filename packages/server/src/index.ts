/**
 * Game server: WebSockets at /ws for play, and (in production) the built
 * client from packages/client/dist for everything else, so one service runs
 * the whole game.
 */

import { randomInt, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  normalizeCode,
  type ClientMessage,
  type ServerMessage,
} from "@dice-game/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { Room, type Result } from "./room.ts";

const PORT = Number(process.env.PORT ?? 8787);
/** How long a room with nobody connected sticks around before it's deleted. */
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_BYTES = 4096;

interface Connection {
  code: string;
  playerId: string;
}

const rooms = new Map<string, Room>();
const sockets = new Map<WebSocket, Connection | null>();
const pauseTimers = new Map<string, NodeJS.Timeout>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

const roomDeps = {
  // crypto.randomInt is uniform, so dice are fair: randomInt(6) / 6 lands in [0, 1).
  random: () => randomInt(6) / 6,
  now: () => Date.now(),
  newId: () => randomUUID(),
};

function newCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room: Room) {
  const message: ServerMessage = { type: "room", room: room.view() };
  for (const [ws, conn] of sockets) if (conn?.code === room.code) send(ws, message);
}

/** After any change: keep the turn-over pause timer and empty-room cleanup in step with the room. */
function afterChange(room: Room) {
  clearTimeout(pauseTimers.get(room.code));
  pauseTimers.delete(room.code);
  if (room.pauseEndsAt !== null) {
    const delay = Math.max(0, room.pauseEndsAt - Date.now());
    pauseTimers.set(
      room.code,
      setTimeout(() => {
        pauseTimers.delete(room.code);
        if (room.advance().ok) afterChange(room);
      }, delay),
    );
  }

  clearTimeout(cleanupTimers.get(room.code));
  cleanupTimers.delete(room.code);
  if (room.isEmpty) {
    cleanupTimers.set(
      room.code,
      setTimeout(() => {
        clearTimeout(pauseTimers.get(room.code));
        pauseTimers.delete(room.code);
        cleanupTimers.delete(room.code);
        rooms.delete(room.code);
      }, EMPTY_ROOM_TTL_MS),
    );
  }

  broadcast(room);
}

/** Point this socket at a seat, dropping any seat it held before. */
function attach(ws: WebSocket, room: Room, playerId: string) {
  const previous = sockets.get(ws);
  if (previous && (previous.code !== room.code || previous.playerId !== playerId)) detach(ws);
  sockets.set(ws, { code: room.code, playerId });
}

function detach(ws: WebSocket) {
  const conn = sockets.get(ws);
  sockets.set(ws, null);
  if (!conn) return;
  const room = rooms.get(conn.code);
  if (!room) return;
  // Another tab may still hold this seat.
  const stillHere = [...sockets.entries()].some(([other, c]) => other !== ws && c?.code === conn.code && c.playerId === conn.playerId);
  if (!stillHere) room.setConnected(conn.playerId, false);
  afterChange(room);
}

function handle(ws: WebSocket, message: ClientMessage) {
  const conn = sockets.get(ws) ?? null;

  switch (message.type) {
    case "create": {
      const room = new Room(newCode(), Number(message.maxPlayers), roomDeps);
      const joined = room.join(String(message.name ?? ""));
      if (!joined.ok) return send(ws, { type: "error", message: joined.error });
      rooms.set(room.code, room);
      attach(ws, room, joined.value.id);
      send(ws, { type: "welcome", code: room.code, playerId: joined.value.id, token: joined.value.token });
      return afterChange(room);
    }
    case "join": {
      const room = rooms.get(normalizeCode(String(message.code ?? "")));
      if (!room) return send(ws, { type: "error", message: "There's no game with that code.", fatal: true });
      const joined = room.join(String(message.name ?? ""));
      if (!joined.ok) return send(ws, { type: "error", message: joined.error });
      attach(ws, room, joined.value.id);
      send(ws, { type: "welcome", code: room.code, playerId: joined.value.id, token: joined.value.token });
      return afterChange(room);
    }
    case "resume": {
      const room = rooms.get(normalizeCode(String(message.code ?? "")));
      if (!room) return send(ws, { type: "error", message: "That game has ended.", fatal: true });
      const resumed = room.resume(String(message.playerId), String(message.token));
      if (!resumed.ok) return send(ws, { type: "error", message: resumed.error, fatal: true });
      attach(ws, room, resumed.value.id);
      return afterChange(room);
    }
  }

  if (!conn) return send(ws, { type: "error", message: "Join a game first." });
  const room = rooms.get(conn.code);
  if (!room) return send(ws, { type: "error", message: "That game has ended.", fatal: true });
  const by = conn.playerId;

  let result: Result;
  switch (message.type) {
    case "leave":
      room.leave(by);
      sockets.set(ws, null);
      send(ws, { type: "left" });
      return afterChange(room);
    case "start":
      result = room.start(by);
      break;
    case "select":
      result = room.select(by, message.indices);
      break;
    case "roll":
      result = room.roll(by, message.keep);
      break;
    case "bank":
      result = room.bank(by, message.keep);
      break;
    case "choose":
      result = room.choose(by, message.choice);
      break;
    case "next":
      result = room.next(by);
      break;
    case "playAgain":
      result = room.playAgain(by);
      break;
    default:
      return send(ws, { type: "error", message: "Unknown message." });
  }
  if (!result.ok) return send(ws, { type: "error", message: result.error });
  afterChange(room);
}

// --- Static files for the built client -------------------------------------------------

const clientDist = resolve(fileURLToPath(import.meta.url), "../../../client/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!existsSync(clientDist)) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Dice game server is running. In development, open the Vite client instead.");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = normalize(join(clientDist, decodeURIComponent(url.pathname)));
  const isFile = requested.startsWith(clientDist) && existsSync(requested) && statSync(requested).isFile();
  // Unknown paths (like /room/ABCD) get the app, which routes on the client.
  const file = isFile ? requested : join(clientDist, "index.html");
  const hashed = isFile && file.includes(`${join(clientDist, "assets")}`);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

// --- Wire it up -------------------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });

wss.on("connection", (ws) => {
  sockets.set(ws, null);
  ws.on("message", (data) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(data));
    } catch {
      return send(ws, { type: "error", message: "Bad message." });
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      return send(ws, { type: "error", message: "Bad message." });
    }
    handle(ws, message);
  });
  ws.on("close", () => {
    detach(ws);
    sockets.delete(ws);
  });
});

// Drop connections that silently went away (phone locked, network lost).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const alive = ws as WebSocket & { isAlive?: boolean };
    if (alive.isAlive === false) {
      ws.terminate();
      continue;
    }
    alive.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("connection", (ws) => {
  const alive = ws as WebSocket & { isAlive?: boolean };
  alive.isAlive = true;
  ws.on("pong", () => (alive.isAlive = true));
});
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Dice game server on http://localhost:${PORT}`);
});
