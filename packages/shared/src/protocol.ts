/**
 * How the browser and the game server talk.
 *
 * HTTP:
 *   POST /api/rooms {maxPlayers}  -> 201 {code}          create an empty room
 *   GET  /api/rooms/CODE          -> 200 RoomInfo | 404   check a code before joining
 *   GET  /api/ice                 -> {iceServers}          STUN/TURN servers for voice chat
 *
 * WebSocket /ws/CODE: one socket per room, messages as JSON. The server owns
 * the game: it rolls the dice, checks every move, and sends the whole room to
 * everyone in it after each change.
 */

import type { GameState } from "./game.ts";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const MAX_NAME_LENGTH = 20;
/** How long someone can be away before others can skip them (or the host role moves on). */
export const AWAY_LIMIT_MS = 60_000;
/** Largest WebSocket message the server accepts (voice connection offers run a few KB). */
export const MAX_MESSAGE_BYTES = 16_384;

/** Room codes avoid look-alike characters (0/O, 1/I/L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 4;

/** Tidy up a code typed by a person: uppercase, letters and digits only. */
export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}

export interface MemberView {
  id: string;
  name: string;
  connected: boolean;
  /** How long they've been disconnected, or null while connected. */
  awayMs: number | null;
  /** Whether they're in voice chat, and muted. */
  voice: VoiceStatus;
}

export type VoiceStatus = "off" | "on" | "muted";

/** WebRTC set-up messages, passed between two players through the server. */
export type VoiceSignal =
  | { kind: "offer" | "answer"; sdp: string }
  | { kind: "candidate"; candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } };

/** The current player has been away too long: others can skip them or vote them out. */
export interface StuckView {
  playerId: string;
  /** Players who've voted to remove them. */
  votes: string[];
  /** Everyone else who's connected; all of them must vote yes. */
  voters: string[];
}

export type RoomStatus = "lobby" | "playing" | "finished";

export interface RoomView {
  code: string;
  hostId: string;
  /** Seats the host opened (2-5). */
  maxPlayers: number;
  status: RoomStatus;
  /** Everyone in the room, in seat order. */
  members: MemberView[];
  game: GameState | null;
  /** Dice the current player has tapped but not yet kept, so everyone can watch them choose. */
  selection: number[];
  /** Goes up by one on every roll, so clients know to play the roll animation. */
  rollCount: number;
  /** While a finished turn is on show, how long until play passes on. */
  pauseRemainingMs: number | null;
  stuck: StuckView | null;
}

/** What GET /api/rooms/CODE says about a room before you join it. */
export interface RoomInfo {
  code: string;
  status: RoomStatus;
  players: number;
  maxPlayers: number;
}

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "resume"; playerId: string; token: string }
  | { type: "leave" }
  | { type: "start" }
  | { type: "select"; indices: number[] }
  /** Keep the dice at `keep` (when choosing), then roll the rest. */
  | { type: "roll"; keep: number[] }
  /** Keep the dice at `keep` (when choosing), then bank. */
  | { type: "bank"; keep: number[] }
  | { type: "choose"; choice: "fresh" | "continue" }
  /** Skip the rest of the pause after a turn ends. */
  | { type: "next" }
  /** Skip the turn of a player who's been away too long. */
  | { type: "skipTurn" }
  /** Vote (or take back a vote) to remove a player who's been away too long. */
  | { type: "voteRemove"; vote: boolean }
  /** Joined or left voice chat, or (un)muted. */
  | { type: "voiceState"; status: VoiceStatus }
  /** Voice set-up for one other player; the server passes it straight on. */
  | { type: "voice"; to: string; signal: VoiceSignal }
  | { type: "playAgain" }
  /** Host only: start a new game with the same players right now. */
  | { type: "restart" }
  /** Host only: back to the lobby so people can join or leave. */
  | { type: "backToLobby" }
  /** Host only: stop the game and show final scores. */
  | { type: "endGame" };

export type ServerMessage =
  /** You're in: keep these to rejoin your seat after a disconnect. */
  | { type: "welcome"; code: string; playerId: string; token: string }
  | { type: "room"; room: RoomView }
  /** `fatal` means the room or seat is gone, so the client should forget it. */
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "left" }
  | { type: "voice"; from: string; signal: VoiceSignal };
