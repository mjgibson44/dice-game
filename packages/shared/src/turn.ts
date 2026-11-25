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

import { DICE_PER_TURN, scoreSelection, type Combo, type Face } from "./scoring.ts";

export type TurnPhase = "ready" | "choosing" | "crapped-out" | "banked";

export type CrapOutReason = "no-score" | "over-target";

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

/**
 * Apply a roll. The turn ends with zero if nothing scores, or if every
 * possible selection would push the player over the target.
 */
export function applyRoll(state: TurnState, faces: readonly Face[]): TurnResult {
  if (state.phase !== "ready") return { ok: false, error: "You can't roll right now." };
  if (faces.length !== state.diceToRoll) {
    return { ok: false, error: `Expected ${state.diceToRoll} dice, got ${faces.length}.` };
  }
  const roll = [...faces];
  const cheapest = cheapestSelectionPoints(roll);
  const reason: CrapOutReason | null = cheapest === null ? "no-score" : cheapest > pointsRoom(state) ? "over-target" : null;
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
  if (scored.points > pointsRoom(state)) {
    return { ok: false, error: "That would take you over the target. Set aside fewer points." };
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
