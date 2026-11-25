/**
 * Messages between the browser and the game server, sent as JSON over one
 * WebSocket. The server owns the game: it rolls the dice, checks every move,
 * and sends the whole room to everyone after each change.
 */

import type { GameState } from "./game.ts";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const MAX_NAME_LENGTH = 20;

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
}

export type ClientMessage =
  | { type: "create"; name: string; maxPlayers: number }
  | { type: "join"; code: string; name: string }
  | { type: "resume"; code: string; playerId: string; token: string }
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
  | { type: "playAgain" };

export type ServerMessage =
  /** You're in: keep these to rejoin your seat after a disconnect. */
  | { type: "welcome"; code: string; playerId: string; token: string }
  | { type: "room"; room: RoomView }
  /** `fatal` means the room or seat is gone, so the client should forget it. */
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "left" };
