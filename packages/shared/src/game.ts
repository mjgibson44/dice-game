/**
 * A whole game: players taking turns, the 350 opening, live dice passed from
 * one player to the next, and winning on exactly the target score.
 *
 * Pure and serializable, so the server can hold it and send it to every
 * player, and practice mode can run it in the browser.
 *
 *   deciding ──choose fresh / continue──▶ playing ──bank / crap out──▶ turn-over ──next──▶ ...
 *   (only when the previous player banked with dice this player may take over)
 */

import type { Face } from "./scoring.ts";
import {
  applyRoll,
  bank,
  isTurnOver,
  keepDice,
  startTurn,
  type CrapOutReason,
  type TurnLimits,
  type TurnResult,
  type TurnState,
} from "./turn.ts";

export interface GameConfig {
  /** Score a player must hit exactly to win. */
  target: number;
  /** Points needed in a single turn before a player's first bank counts. */
  openingMin: number;
}

export const DEFAULT_CONFIG: GameConfig = { target: 10_000, openingMin: 350 };

/** How long everyone sees how a turn ended (bank or crap-out) before play passes automatically. */
export const TURN_OVER_PAUSE_MS = 5000;

/** The smallest amount any keep can add (a single 5). */
const SMALLEST_KEEP = 50;

export interface Player {
  id: string;
  name: string;
  score: number;
  onBoard: boolean;
}

/** What the previous player banked, which the next player may carry on from. */
export interface LiveDice {
  fromPlayerId: string;
  turnPoints: number;
  diceToRoll: number;
}

export type DeadDiceReason = "not-on-board" | "no-room";

export type GamePhase = "deciding" | "playing" | "turn-over" | "finished";

export interface TurnRecord {
  turnNumber: number;
  playerId: string;
  outcome: "banked" | "crapped-out" | "skipped";
  /** Points added to the player's score. */
  points: number;
  /** Points picked up from the previous player's live dice. */
  inherited: number;
  crapOutReason: CrapOutReason | null;
}

export interface GameState {
  config: GameConfig;
  players: Player[];
  /** Index into players of whose turn it is. */
  current: number;
  phase: GamePhase;
  turn: TurnState | null;
  /** Live dice from the previous player's bank. */
  live: LiveDice | null;
  /** Set when the previous player left live dice that the current player can't use. */
  deadDice: DeadDiceReason | null;
  turnNumber: number;
  winnerId: string | null;
  /** Why the game ended: someone hit the target, or everyone else was removed. */
  endReason?: "target" | "last-player";
  history: TurnRecord[];
}

export type GameResult = { ok: true; state: GameState } | { ok: false; error: string };

export function currentPlayer(state: GameState): Player {
  return state.players[state.current]!;
}

function limitsFor(player: Player, config: GameConfig): TurnLimits {
  return {
    maxTurnPoints: config.target - player.score,
    minBank: player.onBoard ? 0 : config.openingMin,
  };
}

/** Whether the current player may carry on from the live dice, and if not, why. */
export function liveDiceStatus(state: GameState): { usable: true } | { usable: false; reason: DeadDiceReason } | null {
  if (!state.live) return null;
  const player = currentPlayer(state);
  if (!player.onBoard) return { usable: false, reason: "not-on-board" };
  if (player.score + state.live.turnPoints + SMALLEST_KEEP > state.config.target) return { usable: false, reason: "no-room" };
  return { usable: true };
}

/** Set up the current player's turn: offer the live dice if they can use them, otherwise start fresh. */
function beginTurn(state: GameState): GameState {
  const status = liveDiceStatus(state);
  if (status?.usable) return { ...state, phase: "deciding", turn: null, deadDice: null };
  return {
    ...state,
    phase: "playing",
    turn: startTurn({ limits: limitsFor(currentPlayer(state), state.config) }),
    deadDice: status && !status.usable ? status.reason : null,
  };
}

export interface NewPlayer {
  id: string;
  name: string;
  /** Starting score and board status, for testing. Defaults to 0 and off the board. */
  score?: number;
  onBoard?: boolean;
}

export function createGame(players: NewPlayer[], config: GameConfig = DEFAULT_CONFIG): GameState {
  if (players.length < 1) throw new Error("A game needs at least one player.");
  return beginTurn({
    config,
    players: players.map((p) => ({ id: p.id, name: p.name, score: p.score ?? 0, onBoard: p.onBoard ?? false })),
    current: 0,
    phase: "playing",
    turn: null,
    live: null,
    deadDice: null,
    turnNumber: 1,
    winnerId: null,
    history: [],
  });
}

/** Start fresh with five dice, or carry on from the previous player's live dice. */
export function chooseStart(state: GameState, choice: "fresh" | "continue"): GameResult {
  if (state.phase !== "deciding" || !state.live) return { ok: false, error: "There are no live dice to choose from." };
  const limits = limitsFor(currentPlayer(state), state.config);
  const turn =
    choice === "continue"
      ? startTurn({ limits, carry: { turnPoints: state.live.turnPoints, diceToRoll: state.live.diceToRoll } })
      : startTurn({ limits });
  return { ok: true, state: { ...state, phase: "playing", turn } };
}

function finishTurn(state: GameState, turn: TurnState): GameState {
  const player = currentPlayer(state);
  const banked = turn.phase === "banked";
  const points = banked ? turn.turnPoints : 0;
  const record: TurnRecord = {
    turnNumber: state.turnNumber,
    playerId: player.id,
    outcome: banked ? "banked" : "crapped-out",
    points,
    inherited: turn.inheritedPoints,
    crapOutReason: turn.crapOutReason,
  };
  const updated: Player = banked ? { ...player, score: player.score + points, onBoard: true } : player;
  const players = state.players.map((p, i) => (i === state.current ? updated : p));
  const won = updated.score === state.config.target;
  return {
    ...state,
    players,
    turn,
    phase: won ? "finished" : "turn-over",
    live: banked && !won ? { fromPlayerId: player.id, turnPoints: turn.turnPoints, diceToRoll: turn.diceToRoll } : null,
    winnerId: won ? player.id : null,
    ...(won ? { endReason: "target" as const } : {}),
    history: [...state.history, record],
  };
}

function withTurn(state: GameState, result: TurnResult): GameResult {
  if (!result.ok) return result;
  if (isTurnOver(result.state)) return { ok: true, state: finishTurn(state, result.state) };
  return { ok: true, state: { ...state, turn: result.state } };
}

function requirePlaying(state: GameState): { ok: false; error: string } | null {
  if (state.phase !== "playing" || !state.turn) return { ok: false, error: "It's not time to play dice." };
  return null;
}

export function roll(state: GameState, faces: readonly Face[]): GameResult {
  return requirePlaying(state) ?? withTurn(state, applyRoll(state.turn!, faces));
}

export function keep(state: GameState, indices: readonly number[]): GameResult {
  return requirePlaying(state) ?? withTurn(state, keepDice(state.turn!, indices));
}

export function bankTurn(state: GameState): GameResult {
  return requirePlaying(state) ?? withTurn(state, bank(state.turn!));
}

/** Pass play to the next player once the current turn is over. */
export function nextTurn(state: GameState): GameResult {
  if (state.phase !== "turn-over") return { ok: false, error: "The turn isn't over yet." };
  return {
    ok: true,
    state: beginTurn({
      ...state,
      current: (state.current + 1) % state.players.length,
      turnNumber: state.turnNumber + 1,
      turn: null,
    }),
  };
}

/**
 * Skip the current player's turn (they've gone away). It scores nothing, any
 * live dice are dropped, and the next player starts fresh.
 */
export function skipTurn(state: GameState): GameResult {
  if (state.phase === "turn-over") return nextTurn(state);
  if (state.phase !== "playing" && state.phase !== "deciding") return { ok: false, error: "There's no turn to skip." };
  const record: TurnRecord = {
    turnNumber: state.turnNumber,
    playerId: currentPlayer(state).id,
    outcome: "skipped",
    points: 0,
    inherited: 0,
    crapOutReason: null,
  };
  return {
    ok: true,
    state: beginTurn({
      ...state,
      history: [...state.history, record],
      live: null,
      current: (state.current + 1) % state.players.length,
      turnNumber: state.turnNumber + 1,
      turn: null,
    }),
  };
}

/**
 * Take a player out of the game. If it was their turn, the next player starts.
 * If only one player is left, they win.
 */
export function removePlayer(state: GameState, playerId: string): GameResult {
  const index = state.players.findIndex((p) => p.id === playerId);
  if (index < 0) return { ok: false, error: "That player isn't in the game." };
  if (state.phase === "finished") return { ok: false, error: "The game is over." };
  const players = state.players.filter((_, i) => i !== index);
  const live = state.live?.fromPlayerId === playerId ? null : state.live;

  if (players.length === 1) {
    return {
      ok: true,
      state: { ...state, players, current: 0, phase: "finished", turn: null, live: null, winnerId: players[0]!.id, endReason: "last-player" },
    };
  }
  if (players.length === 0) return { ok: false, error: "Can't remove the last player." };

  if (index === state.current) {
    // Their turn ends where it is; whoever sat after them starts now.
    return {
      ok: true,
      state: beginTurn({ ...state, players, live: null, current: index % players.length, turnNumber: state.turnNumber + 1, turn: null }),
    };
  }
  const next = { ...state, players, live, current: index < state.current ? state.current - 1 : state.current };
  // The current player was choosing whether to use the removed player's live dice: that offer is gone.
  return { ok: true, state: next.phase === "deciding" && !live ? beginTurn(next) : next };
}
