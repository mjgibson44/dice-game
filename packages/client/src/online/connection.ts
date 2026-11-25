/**
 * One WebSocket to the game server for the whole app. It reconnects by
 * itself (phones drop connections when locked or switching networks) and
 * rejoins your seat each time using the saved session.
 */

import type { ClientMessage, RoomView, ServerMessage } from "@dice-game/shared";
import { useSyncExternalStore } from "react";

export interface Session {
  code: string;
  playerId: string;
  token: string;
}

const SESSION_KEY = "dice-game:session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export interface ConnectionState {
  status: "idle" | "connecting" | "open" | "reconnecting";
  room: RoomView | null;
  /** When `room` arrived (Date.now()), to turn the server's remaining pause into a local end time. */
  roomReceivedAt: number;
  me: string | null;
  error: string | null;
  /** The room or seat is gone for good. */
  fatal: boolean;
}

const INITIAL: ConnectionState = { status: "idle", room: null, roomReceivedAt: 0, me: null, error: null, fatal: false };

class Connection {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private listeners = new Set<() => void>();
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ConnectionState = INITIAL;

  constructor() {
    // Coming back to a backgrounded tab: reconnect straight away rather than waiting out the backoff.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.state.status === "reconnecting") this.connect();
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private connect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;

    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    this.ws = ws;
    if (this.state.status === "idle") this.set({ status: "connecting" });

    ws.onopen = () => {
      this.retries = 0;
      this.set({ status: "open" });
      const session = loadSession();
      if (session) this.raw({ type: "resume", ...session });
      for (const message of this.queue.splice(0)) this.raw(message);
    };
    ws.onmessage = (event) => this.receive(JSON.parse(String(event.data)) as ServerMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
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
        this.set({ room: message.room, roomReceivedAt: Date.now(), error: null, fatal: false });
        break;
      case "error":
        if (message.fatal) {
          saveSession(null);
          this.set({ room: null, me: null, error: message.message, fatal: true });
        } else {
          this.set({ error: message.message });
        }
        break;
      case "left":
        saveSession(null);
        this.set({ room: null, me: null });
        break;
    }
  }

  /** Rejoin the seat saved for this room code. */
  resume(session: Session) {
    this.set({ me: session.playerId, fatal: false, error: null });
    if (this.ws?.readyState === WebSocket.OPEN) this.raw({ type: "resume", ...session });
    else this.connect();
  }

  leave() {
    this.send({ type: "leave" });
    saveSession(null);
    this.set({ room: null, me: null, error: null, fatal: false });
  }

  clearError() {
    this.set({ error: null, fatal: false });
  }
}

export const connection = new Connection();

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getState);
}
