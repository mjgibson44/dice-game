/**
 * One player's turn as a pure state machine. Randomness is injected: callers
 * pass the rolled faces in, so the server (or practice mode) owns the RNG
 * and tests can script exact rolls.
 *
 *   ready ──roll──▶ choosing ──keep──▶ ready ──roll──▶ ...
 *     │                │                 │
 *     │                └─(nothing can be kept)─▶ crapped-out
 *     └────────────────bank (after at least one keep)──▶ banked
 *
 * A turn can start fresh (0 points, 5 dice) or carry on from the previous
 * player's banked turn ("live dice"); see game.ts.
 */

import { bestSelection, DICE_PER_TURN, scoreSelection, type Combo, type Face } from "./scoring.ts";

export type TurnPhase = "ready" | "choosing" | "crapped-out" | "banked";

/**
 * "over-target": every scoring choice would go over the target.
 * "not-exact": the roll would only finish the game by leaving scoring dice
 * behind, but on the roll that lands on the target every scoring die counts.
 */
export type CrapOutReason = "no-score" | "over-target" | "not-exact";

export interface KeptGroup {
  faces: Face[];
  points: number;
  combos: Combo[];
}

export interface TurnLimits {
  /** Most points this turn may reach (target minus the player's score), or null for no cap. */
  maxTurnPoints: number | null;
  /** Fewest points this turn must reach before it can be banked (the 350 opening). */
  minBank: number;
}

export interface TurnState {
  phase: TurnPhase;
  /** Dice the player will throw on the next roll. */
  diceToRoll: number;
  /** The faces showing from the latest roll, or null before the first roll. */
  roll: Face[] | null;
  /** Dice set aside so far this turn, one group per roll. */
  kept: KeptGroup[];
  /** Points accumulated this turn, including any inherited points (lost on a crap-out). */
  turnPoints: number;
  /** Points picked up from the previous player's live dice. */
  inheritedPoints: number;
  /** How many times every die has scored and the player picked all five back up. */
  hotDiceCount: number;
  limits: TurnLimits;
  crapOutReason: CrapOutReason | null;
}

export type TurnResult = { ok: true; state: TurnState } | { ok: false; error: string };

export const NO_LIMITS: TurnLimits = { maxTurnPoints: null, minBank: 0 };

export interface StartTurnOptions {
  limits?: TurnLimits;
  /** Carry on from the previous player's banked turn. */
  carry?: { turnPoints: number; diceToRoll: number };
}

export function startTurn(options: StartTurnOptions = {}): TurnState {
  const carry = options.carry;
  return {
    phase: "ready",
    diceToRoll: carry?.diceToRoll ?? DICE_PER_TURN,
    roll: null,
    kept: [],
    turnPoints: carry?.turnPoints ?? 0,
    inheritedPoints: carry?.turnPoints ?? 0,
    hotDiceCount: 0,
    limits: options.limits ?? NO_LIMITS,
    crapOutReason: null,
  };
}

/** Random faces for `count` dice. */
export function rollDice(count: number, random: () => number = Math.random): Face[] {
  return Array.from({ length: count }, () => (Math.floor(random() * 6) + 1) as Face);
}

/** The fewest points any valid selection from this roll is worth, or null if nothing scores. */
export function cheapestSelectionPoints(roll: readonly number[]): number | null {
  let cheapest: number | null = null;
  for (let mask = 1; mask < 1 << roll.length; mask++) {
    const dice = roll.filter((_, i) => mask & (1 << i));
    const scored = scoreSelection(dice);
    if (scored && (cheapest === null || scored.points < cheapest)) cheapest = scored.points;
  }
  return cheapest;
}

/** Points still allowed this turn before going over the target. */
export function pointsRoom(state: TurnState): number {
  const max = state.limits.maxTurnPoints;
  return max === null ? Infinity : max - state.turnPoints;
}

/** Everything the roll scores, counting every scoring die in it (0 if nothing scores). */
export function rollPoints(roll: readonly number[]): number {
  return bestSelection(roll)?.points ?? 0;
}

export type KeepProblem = "over-target" | "not-exact";

/**
 * Whether setting aside `points` from the current roll is allowed under the
 * target. Points that stay under the target are fine. Landing exactly on the
 * target only counts when the whole roll scores exactly that much: a player
 * can't leave scoring dice behind to finish (the "exact roll" rule).
 */
export function keepProblem(state: TurnState, points: number): KeepProblem | null {
  const room = pointsRoom(state);
  if (points > room) return "over-target";
  if (points === room && state.roll && rollPoints(state.roll) !== room) return "not-exact";
  return null;
}

/**
 * Apply a roll. The turn ends with zero if nothing scores, or if no selection
 * is allowed: everything would go over the target, or the only way to land
 * on it leaves scoring dice behind.
 */
export function applyRoll(state: TurnState, faces: readonly Face[]): TurnResult {
  if (state.phase !== "ready") return { ok: false, error: "You can't roll right now." };
  if (faces.length !== state.diceToRoll) {
    return { ok: false, error: `Expected ${state.diceToRoll} dice, got ${faces.length}.` };
  }
  const roll = [...faces];
  const cheapest = cheapestSelectionPoints(roll);
  const room = pointsRoom(state);
  const reason: CrapOutReason | null =
    cheapest === null
      ? "no-score"
      : cheapest < room || rollPoints(roll) === room
        ? null
        : cheapest > room
          ? "over-target"
          : "not-exact";
  if (reason) {
    return { ok: true, state: { ...state, phase: "crapped-out", roll, turnPoints: 0, crapOutReason: reason } };
  }
  return { ok: true, state: { ...state, phase: "choosing", roll } };
}

/**
 * Set aside the dice at `indices` of the current roll. All of them must score,
 * and together they can't take the player over the target. If that uses up
 * every die, the player picks all five back up (hot dice).
 */
export function keepDice(state: TurnState, indices: readonly number[]): TurnResult {
  if (state.phase !== "choosing" || !state.roll) {
    return { ok: false, error: "There's no roll to keep dice from." };
  }
  const roll = state.roll;
  const unique = new Set(indices);
  if (unique.size !== indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= roll.length)) {
    return { ok: false, error: "Invalid dice selection." };
  }
  const faces = indices.map((i) => roll[i]!);
  const scored = scoreSelection(faces);
  if (!scored) {
    return {
      ok: false,
      error: indices.length === 0 ? "Set aside at least one scoring die." : "Every die you set aside has to score.",
    };
  }
  const problem = keepProblem(state, scored.points);
  if (problem === "over-target") {
    return { ok: false, error: "That would take you over the target. Set aside fewer points." };
  }
  if (problem === "not-exact") {
    return {
      ok: false,
      error: `To land on the target, every scoring die in the roll counts, and this roll scores ${rollPoints(roll)}.`,
    };
  }

  const remaining = state.diceToRoll - faces.length;
  const hotDice = remaining === 0;
  return {
    ok: true,
    state: {
      ...state,
      phase: "ready",
      diceToRoll: hotDice ? DICE_PER_TURN : remaining,
      kept: [...state.kept, { faces: [...faces].sort((a, b) => a - b), points: scored.points, combos: scored.combos }],
      turnPoints: state.turnPoints + scored.points,
      hotDiceCount: state.hotDiceCount + (hotDice ? 1 : 0),
    },
  };
}

/** The highest-scoring selection the player is allowed to set aside, or null if there's none. */
export function bestAllowedSelection(state: TurnState): { indices: number[]; points: number } | null {
  const roll = state.roll;
  if (state.phase !== "choosing" || !roll) return null;
  let best: { indices: number[]; points: number } | null = null;
  for (let mask = 1; mask < 1 << roll.length; mask++) {
    const indices = roll.map((_, i) => i).filter((i) => mask & (1 << i));
    const scored = scoreSelection(indices.map((i) => roll[i]!));
    if (!scored || keepProblem(state, scored.points)) continue;
    if (!best || scored.points > best.points || (scored.points === best.points && indices.length > best.indices.length)) {
      best = { indices, points: scored.points };
    }
  }
  return best;
}

/** Why the turn can't be banked right now, or null if it can. */
export function bankBlocker(state: TurnState): string | null {
  if (state.phase !== "ready" || state.kept.length === 0) return "Set aside scoring dice before banking.";
  if (state.turnPoints < state.limits.minBank) {
    return `You need ${state.limits.minBank} points in one turn to get on the board.`;
  }
  return null;
}

/** End the turn and keep the points. */
export function bank(state: TurnState): TurnResult {
  const blocker = bankBlocker(state);
  if (blocker) return { ok: false, error: blocker };
  return { ok: true, state: { ...state, phase: "banked" } };
}

export function isTurnOver(state: TurnState): boolean {
  return state.phase === "banked" || state.phase === "crapped-out";
}
