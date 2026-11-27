import { describe, expect, it } from "vitest";
import type { Face } from "../src/scoring.ts";
import {
  applyRoll,
  bank,
  bestAllowedSelection,
  isTurnOver,
  keepDice,
  keepProblem,
  rollDice,
  rollPoints,
  startTurn,
  type TurnResult,
  type TurnState,
} from "../src/turn.ts";

function ok(result: TurnResult): TurnState {
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

const roll = (s: TurnState, faces: Face[]) => ok(applyRoll(s, faces));
const keep = (s: TurnState, indices: number[]) => ok(keepDice(s, indices));

describe("a turn", () => {
  it("starts with five dice and no points", () => {
    expect(startTurn()).toMatchObject({ phase: "ready", diceToRoll: 5, turnPoints: 0, roll: null });
  });

  it("craps out on a first roll with nothing that scores", () => {
    const s = roll(startTurn(), [2, 3, 4, 6, 6]);
    expect(s.phase).toBe("crapped-out");
    expect(isTurnOver(s)).toBe(true);
  });

  it("two 5s: keep one and roll four (rules example)", () => {
    let s = roll(startTurn(), [5, 5, 2, 3, 6]);
    s = keep(s, [0]);
    expect(s).toMatchObject({ phase: "ready", diceToRoll: 4, turnPoints: 50 });
  });

  it("two 5s: keep both and roll three (rules example)", () => {
    let s = roll(startTurn(), [5, 5, 2, 3, 6]);
    s = keep(s, [0, 1]);
    expect(s).toMatchObject({ diceToRoll: 3, turnPoints: 100 });
  });

  it("two 5s: keep both and bank 100 (rules example)", () => {
    let s = roll(startTurn(), [5, 5, 2, 3, 6]);
    s = ok(bank(keep(s, [0, 1])));
    expect(s).toMatchObject({ phase: "banked", turnPoints: 100 });
    expect(isTurnOver(s)).toBe(true);
  });

  it("loses everything on a later crap-out", () => {
    let s = keep(roll(startTurn(), [1, 1, 1, 2, 3]), [0, 1, 2]);
    expect(s.turnPoints).toBe(1000);
    s = roll(s, [4, 6]);
    expect(s).toMatchObject({ phase: "crapped-out", turnPoints: 0 });
  });

  it("can't bank before setting any dice aside", () => {
    expect(bank(startTurn()).ok).toBe(false);
  });

  it("can't bank or roll while choosing, only keep", () => {
    const s = roll(startTurn(), [1, 2, 3, 4, 6]);
    expect(bank(s).ok).toBe(false);
    expect(applyRoll(s, [1, 2, 3, 4, 6]).ok).toBe(false);
  });

  it("rejects keeping a die that doesn't score", () => {
    const s = roll(startTurn(), [1, 2, 3, 4, 6]);
    expect(keepDice(s, [0, 4]).ok).toBe(false);
    expect(keepDice(s, []).ok).toBe(false);
  });

  it("rejects bad indices", () => {
    const s = roll(startTurn(), [1, 2, 3, 4, 6]);
    expect(keepDice(s, [0, 0]).ok).toBe(false);
    expect(keepDice(s, [5]).ok).toBe(false);
    expect(keepDice(s, [-1]).ok).toBe(false);
  });

  it("rejects a roll with the wrong number of dice", () => {
    expect(applyRoll(startTurn(), [1, 2, 3]).ok).toBe(false);
  });
});

describe("hot dice", () => {
  it("all five scoring in one roll: pick all five back up", () => {
    const s = keep(roll(startTurn(), [1, 1, 1, 5, 5]), [0, 1, 2, 3, 4]);
    expect(s).toMatchObject({ phase: "ready", diceToRoll: 5, turnPoints: 1500, hotDiceCount: 1 });
  });

  it("all five scoring over a series of rolls: pick all five back up", () => {
    let s = keep(roll(startTurn(), [1, 2, 3, 6, 6]), [0]); // 100, 4 left
    s = keep(roll(s, [2, 2, 2, 5]), [0, 1, 2, 3]); // 250, 0 left
    expect(s).toMatchObject({ diceToRoll: 5, turnPoints: 350, hotDiceCount: 1 });
    s = keep(roll(s, [5, 2, 3, 4, 6]), [0]);
    expect(s).toMatchObject({ diceToRoll: 4, turnPoints: 400 });
  });
});

describe("rollDice", () => {
  it("returns faces 1-6", () => {
    expect(rollDice(5, () => 0)).toEqual([1, 1, 1, 1, 1]);
    expect(rollDice(3, () => 0.9999)).toEqual([6, 6, 6]);
  });
});

describe("the exact roll rule", () => {
  // 200 left before the target.
  const need200 = () => startTurn({ limits: { maxTurnPoints: 200, minBank: 0 } });

  it("counts every scoring die in the roll", () => {
    expect(rollPoints([1, 1, 5, 4, 4])).toBe(250);
    expect(rollPoints([2, 3, 4, 6, 6])).toBe(0);
  });

  it("only blocks landing exactly on the target when the roll scores more", () => {
    const s = roll(need200(), [1, 1, 5, 4, 4]);
    expect(keepProblem(s, 150)).toBeNull();
    expect(keepProblem(s, 200)).toBe("not-exact");
    expect(keepProblem(s, 250)).toBe("over-target");
  });

  it("has no effect without a target", () => {
    const s = roll(startTurn(), [1, 1, 5, 4, 4]);
    expect(keepProblem(s, 200)).toBeNull();
  });

  it("the hint picks the best selection the rule allows", () => {
    expect(bestAllowedSelection(roll(need200(), [1, 1, 5, 4, 4]))).toEqual({ indices: [0, 2], points: 150 });
    expect(bestAllowedSelection(roll(need200(), [1, 1, 3, 4, 6]))).toEqual({ indices: [0, 1], points: 200 });
  });
});
