/**
 * Scoring rules. Pure functions only: no randomness, no game state.
 *
 * A "selection" is the dice a player sets aside from a single roll. Every die
 * in a selection must be part of some scoring combo, and when the same dice
 * could be grouped more than one way, the player gets the best grouping.
 */

export type Face = 1 | 2 | 3 | 4 | 5 | 6;

export const DICE_PER_TURN = 5;

export type ComboKind =
  | "single"
  | "three-of-a-kind"
  | "four-of-a-kind"
  | "five-of-a-kind"
  | "run-4"
  | "run-5"
  | "full-house";

export interface Combo {
  kind: ComboKind;
  /** The dice faces this combo uses, sorted ascending. */
  faces: Face[];
  points: number;
}

export interface ScoredSelection {
  points: number;
  combos: Combo[];
}

/** Value of three of a kind: three 1s are 1000, otherwise face x 100. */
export function setValue(face: Face): number {
  return face === 1 ? 1000 : face * 100;
}

/**
 * Value the pair contributes to a full house. A pair is valued like three of
 * that face, except a pair of 1s counts 100 each (200), not 1000.
 */
export function fullHousePairValue(face: Face): number {
  return face === 1 ? 200 : setValue(face);
}

const FACES: readonly Face[] = [1, 2, 3, 4, 5, 6];

type Counts = [number, number, number, number, number, number, number]; // index 1..6

function countFaces(dice: readonly number[]): Counts {
  const counts: Counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) {
    if (!Number.isInteger(d) || d < 1 || d > 6) {
      throw new RangeError(`Invalid die face: ${d}`);
    }
    counts[d]! += 1;
  }
  return counts;
}

function repeat(face: Face, n: number): Face[] {
  return Array.from({ length: n }, () => face);
}

/** Every combo that can be taken out of the dice described by `counts`. */
function candidateCombos(counts: Counts): Combo[] {
  const combos: Combo[] = [];

  for (const f of FACES) {
    const c = counts[f]!;
    if (f === 1 && c >= 1) combos.push({ kind: "single", faces: [1], points: 100 });
    if (f === 5 && c >= 1) combos.push({ kind: "single", faces: [5], points: 50 });
    if (c >= 3) combos.push({ kind: "three-of-a-kind", faces: repeat(f, 3), points: setValue(f) });
    if (c >= 4) combos.push({ kind: "four-of-a-kind", faces: repeat(f, 4), points: setValue(f) * 2 });
    if (c >= 5) combos.push({ kind: "five-of-a-kind", faces: repeat(f, 5), points: setValue(f) * 4 });
  }

  for (const start of [1, 2, 3] as const) {
    const run = [start, start + 1, start + 2, start + 3] as Face[];
    if (run.every((f) => counts[f]! >= 1)) combos.push({ kind: "run-4", faces: run, points: 250 });
  }
  for (const start of [1, 2] as const) {
    const run = [start, start + 1, start + 2, start + 3, start + 4] as Face[];
    if (run.every((f) => counts[f]! >= 1)) combos.push({ kind: "run-5", faces: run, points: 500 });
  }

  for (const triple of FACES) {
    if (counts[triple]! < 3) continue;
    for (const pair of FACES) {
      if (pair === triple || counts[pair]! < 2) continue;
      const faces = [...repeat(triple, 3), ...repeat(pair, 2)].sort((a, b) => a - b);
      combos.push({
        kind: "full-house",
        faces,
        points: setValue(triple) + fullHousePairValue(pair),
      });
    }
  }

  return combos;
}

function bestCover(counts: Counts): ScoredSelection | null {
  if (counts.every((c) => c === 0)) return { points: 0, combos: [] };

  let best: ScoredSelection | null = null;
  for (const combo of candidateCombos(counts)) {
    const rest = [...counts] as Counts;
    for (const f of combo.faces) rest[f]! -= 1;
    const sub = bestCover(rest);
    if (!sub) continue;
    const points = combo.points + sub.points;
    if (!best || points > best.points) {
      best = { points, combos: [combo, ...sub.combos] };
    }
  }
  return best;
}

/**
 * Score dice set aside from one roll. Returns null if the selection is empty
 * or if any die in it does not belong to a scoring combo.
 */
export function scoreSelection(dice: readonly number[]): ScoredSelection | null {
  if (dice.length === 0) return null;
  return bestCover(countFaces(dice));
}

function* nonEmptySubsets<T>(items: readonly T[]): Generator<T[]> {
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(items[i]!);
    yield subset;
  }
}

/** True if at least one die in the roll can score. False means a crap-out. */
export function hasAnyScore(roll: readonly number[]): boolean {
  // Every run contains a 1 or a 5, so a roll scores exactly when it has a 1,
  // a 5, or three of a kind. Kept in sync with the full search by tests.
  const counts = countFaces(roll);
  return counts[1]! > 0 || counts[5]! > 0 || counts.some((c) => c >= 3);
}

/** The highest-scoring selection available in a roll, or null on a crap-out. */
export function bestSelection(
  roll: readonly number[],
): (ScoredSelection & { indices: number[] }) | null {
  let best: (ScoredSelection & { indices: number[] }) | null = null;
  for (const indices of nonEmptySubsets(roll.map((_, i) => i))) {
    const scored = scoreSelection(indices.map((i) => roll[i]!));
    if (!scored) continue;
    if (!best || scored.points > best.points || (scored.points === best.points && indices.length > best.indices.length)) {
      best = { ...scored, indices };
    }
  }
  return best;
}
