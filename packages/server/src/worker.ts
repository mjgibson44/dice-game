/**
 * Cloudflare Worker: serves the app, creates rooms, and hands each room's
 * WebSockets to that room's Durable Object (one small, long-lived object per
 * game code that holds the game and saves it after every change).
 */

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_MESSAGE_BYTES,
  normalizeCode,
  type ClientMessage,
  type RoomInfo,
  type ServerMessage,
} from "@dice-game/shared";
import { DurableObject } from "cloudflare:workers";
import { Room, type Result, type RoomDeps, type RoomSnapshot } from "./room.ts";

interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
  /** Optional Cloudflare Realtime TURN key, for voice between phones that can't connect directly. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const STUN_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

/** ICE servers for voice: free STUN always, plus short-lived TURN credentials when a TURN key is set up. */
async function iceServers(env: Env): Promise<unknown[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_SERVERS;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 60 * 60 }),
    });
    if (!res.ok) return STUN_SERVERS;
    const body = (await res.json()) as { iceServers: unknown[] | unknown };
    return [...STUN_SERVERS, ...(Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers])];
  } catch {
    return STUN_SERVERS;
  }
}

/** How long a room with nobody connected sticks around before it's deleted. */
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
/** Browsers ping every 20s; a socket silent for this long is treated as gone. */
const SILENT_SOCKET_MS = 90_000;
/** How often to look for silent sockets while anyone is connected. */
const LIVENESS_CHECK_MS = 30_000;

/** Uniform random integer in [0, n), from the platform's crypto RNG. */
function randomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n; // reject the biased tail
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % n;
}

const roomDeps: RoomDeps = {
  random: () => randomInt(6) / 6,
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { maxPlayers?: unknown };
      const maxPlayers = Number(body.maxPlayers) || 4;
      for (let attempt = 0; attempt < 10; attempt++) {
        let code = "";
        for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
        const created = await env.ROOMS.getByName(code).init(code, maxPlayers);
        if (created) return json({ code }, 201);
      }
      return json({ error: "Couldn't create a game. Try again." }, 503);
    }

    if (url.pathname === "/api/ice" && request.method === "GET") {
      return json({ iceServers: await iceServers(env) });
    }

    const info = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
    if (info && request.method === "GET") {
      const room = await env.ROOMS.getByName(normalizeCode(info[1]!)).info();
      return room ? json(room) : json({ error: "There's no game with that code." }, 404);
    }

    const ws = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (ws) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.ROOMS.getByName(normalizeCode(ws[1]!)).fetch(request);
    }

    // Everything else is the app (Cloudflare serves the built files; unknown paths get index.html).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  playerId: string | null;
  /** When this socket connected, as a baseline before its first ping. */
  openedAt: number;
}

export class GameRoom extends DurableObject<Env> {
  private room: Room | null = null;
  /** When an empty room gets deleted, or null while someone is connected. */
  private cleanupAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer keep-alive pings without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get<RoomSnapshot>("room");
      this.cleanupAt = (await ctx.storage.get<number>("cleanupAt")) ?? null;
      if (snapshot) {
        this.room = Room.restore(snapshot, roomDeps);
        this.syncConnected();
      }
    });
  }

  /** Set up a brand-new room. Returns false if this code is already taken. */
  async init(code: string, maxPlayers: number): Promise<boolean> {
    if (this.room) return false;
    this.room = new Room(code, maxPlayers, roomDeps);
    await this.afterChange();
    return true;
  }

  async info(): Promise<RoomInfo | null> {
    if (!this.room) return null;
    const { code, status, members, maxPlayers } = this.room;
    return { code, status, players: members.length, maxPlayers };
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.room) return new Response("There's no game with that code.", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null, openedAt: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return send(ws, { type: "error", message: "Bad message." });
    let message: ClientMessage;
    try {
      message = JSON.parse(data);
    } catch {
      return send(ws, { type: "error", message: "Bad message." });
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      return send(ws, { type: "error", message: "Bad message." });
    }
    await this.handle(ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
    await this.detach(ws);
  }

  override async webSocketError(ws: WebSocket) {
    await this.detach(ws);
  }

  /**
   * Fires for anything time-based: a turn-over pause ending, someone being away
   * a full minute, checking for silent sockets, or deleting an abandoned room.
   */
  override async alarm() {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    if (this.cleanupAt !== null && now >= this.cleanupAt && room.isEmpty) {
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    const before = this.signature();
    this.dropSilentSockets(now);
    room.tick();
    // Only tell everyone if something they'd see changed (not just the clock moving).
    await this.afterChange(this.signature() !== before);
  }

  private signature(): string {
    const room = this.room!;
    const stuck = room.stuckPlayer();
    return [room.status, room.hostId, room.game?.turnNumber, room.game?.phase, stuck?.id, room.members.map((m) => m.connected).join()].join("|");
  }

  /** Close sockets that stopped pinging (a phone that went to sleep without hanging up). */
  private dropSilentSockets(now: number) {
    let dropped = false;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const lastHeard = Math.max(lastPing, attachment?.openedAt ?? 0);
      if (now - lastHeard > SILENT_SOCKET_MS) {
        try {
          ws.close(4000, "No ping");
        } catch {
          // Already closed.
        }
        dropped = true;
      }
    }
    if (dropped) this.syncConnected();
  }

  private async handle(ws: WebSocket, message: ClientMessage) {
    const room = this.room;
    if (!room) return send(ws, { type: "error", message: "That game has ended.", fatal: true });
    const attachment = ws.deserializeAttachment() as Attachment | null;

    if (message.type === "join" || message.type === "resume") {
      if (message.type === "resume" && room.wasRemoved(String(message.playerId))) {
        return send(ws, { type: "error", message: "You were removed from this game.", fatal: true });
      }
      const seat =
        message.type === "join"
          ? room.join(String(message.name ?? ""))
          : room.resume(String(message.playerId), String(message.token));
      if (!seat.ok) return send(ws, { type: "error", message: seat.error });
      ws.serializeAttachment({ playerId: seat.value.id, openedAt: attachment?.openedAt ?? Date.now() } satisfies Attachment);
      if (message.type === "join") {
        send(ws, { type: "welcome", code: room.code, playerId: seat.value.id, token: seat.value.token });
      }
      return this.afterChange();
    }

    const by = attachment?.playerId;
    if (!by) return send(ws, { type: "error", message: "Join the game first." });

    let result: Result;
    switch (message.type) {
      case "leave":
        room.leave(by);
        ws.serializeAttachment({ playerId: null, openedAt: attachment.openedAt } satisfies Attachment);
        send(ws, { type: "left" });
        return this.afterChange();
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
      case "skipTurn":
        result = room.skipTurn(by);
        break;
      case "voteRemove":
        result = room.voteRemove(by, message.vote);
        break;
      case "restart":
        result = room.restart(by);
        break;
      case "backToLobby":
        result = room.backToLobby(by);
        break;
      case "endGame":
        result = room.endGame(by);
        break;
      case "voiceState":
        result = room.setVoice(by, message.status);
        break;
      case "voice": {
        // Pass voice set-up straight to the other player's sockets; nothing to save.
        if (!room.canSignal(by, message.to)) return send(ws, { type: "error", message: "Can't reach that player." });
        const relay: ServerMessage = { type: "voice", from: by, signal: message.signal };
        for (const socket of this.ctx.getWebSockets()) {
          if ((socket.deserializeAttachment() as Attachment | null)?.playerId === message.to) send(socket, relay);
        }
        return;
      }
      default:
        return send(ws, { type: "error", message: "Unknown message." });
    }
    if (!result.ok) return send(ws, { type: "error", message: result.error });
    await this.afterChange();
  }

  private async detach(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!this.room || !attachment?.playerId) return;
    this.syncConnected(ws);
    await this.afterChange();
  }

  /** A seat counts as connected while any open socket holds it. */
  private syncConnected(closing?: WebSocket) {
    if (!this.room) return;
    const live = new Set(
      this.ctx
        .getWebSockets()
        .filter((s) => s !== closing && s.readyState === WebSocket.OPEN)
        .map((s) => (s.deserializeAttachment() as Attachment | null)?.playerId)
        .filter(Boolean),
    );
    for (const m of this.room.members) this.room.setConnected(m.id, live.has(m.id));
  }

  /** Save, set the next alarm, and (unless told not to) tell everyone. */
  private async afterChange(broadcast = true) {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    this.cleanupAt = room.isEmpty ? (this.cleanupAt ?? now + EMPTY_ROOM_TTL_MS) : null;
    await this.ctx.storage.put({ room: room.snapshot(), cleanupAt: this.cleanupAt });

    const livenessCheck = this.ctx.getWebSockets().length > 0 ? now + LIVENESS_CHECK_MS : Infinity;
    const next = Math.min(room.nextDeadline() ?? Infinity, this.cleanupAt ?? Infinity, livenessCheck);
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);

    if (!broadcast) return;
    const message = JSON.stringify({ type: "room", room: room.view() } satisfies ServerMessage);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.playerId && socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }
}

function send(ws: WebSocket, message: ServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket already gone.
  }
}
