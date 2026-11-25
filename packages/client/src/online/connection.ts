/**
 * The WebSocket for the room you're in. It reconnects by itself (phones drop
 * connections when locked or switching networks) and rejoins your seat each
 * time using the session saved on this device.
 */

import type { ClientMessage, RoomInfo, RoomView, ServerMessage, VoiceSignal } from "@dice-game/shared";
import { useSyncExternalStore } from "react";

export interface Session {
  code: string;
  playerId: string;
  token: string;
}

const SESSION_KEY = "dice-game:session";
/** Send a keep-alive this often; the server answers "pong" without waking the game. */
const PING_EVERY_MS = 20_000;
/** No pong within this long means the connection is dead (common after a phone sleeps). */
const PONG_TIMEOUT_MS = 6_000;
/** Shorter check when coming back to the tab, so a dead connection is replaced fast. */
const RETURN_PONG_TIMEOUT_MS = 3_000;

/** The seat saved on this device, optionally only if it's for `code`. */
export function loadSession(code?: string): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const session = raw ? (JSON.parse(raw) as Session) : null;
    return session && (!code || session.code === code) ? session : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export async function fetchRoomInfo(code: string): Promise<RoomInfo | null> {
  const res = await fetch(`/api/rooms/${code}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't reach the game server.");
  return (await res.json()) as RoomInfo;
}

export async function createRoom(maxPlayers: number): Promise<string> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxPlayers }),
  });
  if (!res.ok) throw new Error("Couldn't create a game. Try again.");
  return ((await res.json()) as { code: string }).code;
}

export interface ConnectionState {
  status: "idle" | "connecting" | "open" | "reconnecting";
  room: RoomView | null;
  /** When `room` arrived (Date.now()), to turn the server's remaining pause into a local end time. */
  roomReceivedAt: number;
  me: string | null;
  error: string | null;
  /** The room is gone for good. */
  fatal: boolean;
}

const IDLE: ConnectionState = { status: "idle", room: null, roomReceivedAt: 0, me: null, error: null, fatal: false };

class Connection {
  private code: string | null = null;
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private listeners = new Set<() => void>();
  private voiceListeners = new Set<(from: string, signal: VoiceSignal) => void>();
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private everOpened = false;
  private resuming = false;
  private state: ConnectionState = IDLE;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Coming back to the tab or app: the connection may have died while we were away.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (this.state.status === "reconnecting") this.connect();
      else if (this.ws?.readyState === WebSocket.OPEN) this.ping(RETURN_PONG_TIMEOUT_MS);
    });
    addEventListener("online", () => {
      if (this.state.status === "reconnecting") this.connect();
    });
  }

  /** Check the connection is really alive; if no answer comes back in time, start over. */
  private ping(timeoutMs = PONG_TIMEOUT_MS) {
    if (this.ws?.readyState !== WebSocket.OPEN || this.pongDeadline) return;
    this.ws.send("ping");
    this.pongDeadline = setTimeout(() => {
      this.pongDeadline = null;
      this.dropConnection();
    }, timeoutMs);
  }

  private stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    this.pingTimer = null;
    this.pongDeadline = null;
  }

  /** Give up on a connection that looks open but isn't answering, and reconnect now. */
  private dropConnection() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.stopHeartbeat();
    ws.onclose = ws.onmessage = ws.onopen = null;
    ws.close();
    this.retries = 0;
    this.set({ status: "reconnecting" });
    this.connect();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  /** Voice set-up messages from other players. */
  onVoice(listener: (from: string, signal: VoiceSignal) => void) {
    this.voiceListeners.add(listener);
  }

  private set(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Connect to a room (rejoining the saved seat, if there is one). */
  open(code: string) {
    if (this.code === code) return;
    this.close();
    this.code = code;
    this.everOpened = false;
    this.set({ ...IDLE, status: "connecting", me: loadSession(code)?.playerId ?? null });
    this.connect();
  }

  close() {
    this.code = null;
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.queue = [];
    this.set(IDLE);
  }

  private connect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const code = this.code;
    if (!code || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${code}`);
    this.ws = ws;

    ws.onopen = () => {
      this.everOpened = true;
      this.retries = 0;
      this.set({ status: "open" });
      const session = loadSession(code);
      if (session) {
        this.resuming = true;
        this.raw({ type: "resume", playerId: session.playerId, token: session.token });
      }
      for (const message of this.queue.splice(0)) this.raw(message);
      this.stopHeartbeat();
      this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    };
    ws.onmessage = (event) => {
      if (event.data === "pong") {
        if (this.pongDeadline) clearTimeout(this.pongDeadline);
        this.pongDeadline = null;
        return;
      }
      this.receive(JSON.parse(String(event.data)) as ServerMessage);
    };
    ws.onclose = async () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      // Never got in: check whether the room exists at all before retrying forever.
      if (!this.everOpened) {
        const info = await fetchRoomInfo(code).catch(() => undefined);
        if (info === null && this.code === code) {
          if (loadSession(code)) saveSession(null);
          this.set({ status: "idle", fatal: true, error: "There's no game with that code." });
          return;
        }
      }
      if (this.code !== code) return;
      this.set({ status: "reconnecting" });
      const delay = Math.min(8000, 500 * 2 ** this.retries++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private raw(message: ClientMessage) {
    this.ws?.send(JSON.stringify(message));
  }

  send(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.raw(message);
    else {
      this.queue.push(message);
      this.connect();
    }
  }

  private receive(message: ServerMessage) {
    switch (message.type) {
      case "welcome":
        saveSession({ code: message.code, playerId: message.playerId, token: message.token });
        this.set({ me: message.playerId, error: null, fatal: false });
        break;
      case "room":
        this.resuming = false;
        this.set({ room: message.room, roomReceivedAt: Date.now(), error: null, fatal: false });
        break;
      case "error":
        if (message.fatal) {
          this.resuming = false;
          saveSession(null);
          this.set({ room: null, me: null, error: message.message, fatal: true });
        } else if (this.resuming) {
          // Our saved seat is gone (we left, or the game was reset). Offer to join afresh.
          this.resuming = false;
          saveSession(null);
          this.set({ me: null, room: null, error: message.message });
        } else {
          this.set({ error: message.message });
        }
        break;
      case "left":
        saveSession(null);
        this.set({ room: null, me: null });
        break;
      case "voice":
        for (const l of this.voiceListeners) l(message.from, message.signal);
        break;
    }
  }

  leave() {
    // Closing a WebSocket still delivers anything already sent, so this goes out first.
    if (this.ws?.readyState === WebSocket.OPEN) this.raw({ type: "leave" });
    saveSession(null);
    this.close();
  }

  clearError() {
    this.set({ error: null });
  }
}

export const connection = new Connection();

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getState);
}
