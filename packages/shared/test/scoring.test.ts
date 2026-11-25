import { describe, expect, it } from "vitest";
import { bestSelection, hasAnyScore, scoreSelection, type Face } from "../src/scoring.ts";

const points = (dice: number[]) => scoreSelection(dice)?.points ?? null;

describe("singles", () => {
  it.each([
    [[5], 50],
    [[5, 5], 100],
    [[1], 100],
    [[1, 1], 200],
    [[1, 5], 150],
  ])("%j scores %i", (dice, expected) => {
    expect(points(dice)).toBe(expected);
  });
});

describe("three of a kind", () => {
  it.each([
    [1, 1000],
    [2, 200],
    [3, 300],
    [4, 400],
    [5, 500],
    [6, 600],
  ])("three %is score %i", (face, expected) => {
    expect(points([face, face, face])).toBe(expected);
  });
});

describe("four and five of a kind", () => {
  it.each([
    [1, 2000, 4000],
    [2, 400, 800],
    [3, 600, 1200],
    [4, 800, 1600],
    [5, 1000, 2000],
    [6, 1200, 2400],
  ])("%is: four score %i, five score %i", (face, four, five) => {
    expect(points([face, face, face, face])).toBe(four);
    expect(points([face, face, face, face, face])).toBe(five);
  });
});

describe("runs", () => {
  it.each([
    [[1, 2, 3, 4], 250],
    [[2, 3, 4, 5], 250],
    [[3, 4, 5, 6], 250],
    [[1, 2, 3, 4, 5], 500],
    [[2, 3, 4, 5, 6], 500],
    [[6, 4, 3, 5], 250], // order doesn't matter
  ])("%j scores %i", (dice, expected) => {
    expect(points(dice)).toBe(expected);
  });

  it("a 4-run plus a scoring die scores both", () => {
    expect(points([1, 2, 3, 4, 1])).toBe(350);
    expect(points([2, 3, 4, 5, 5])).toBe(300);
  });

  it("a 4-run plus a die that doesn't score is not a valid selection", () => {
    expect(points([1, 2, 3, 4, 6])).toBeNull();
  });
});

describe("full house (examples from the rules)", () => {
  it.each([
    [[2, 2, 2, 5, 5], 700],
    [[5, 5, 5, 2, 2], 700],
    [[6, 6, 6, 4, 4], 1000],
    [[4, 4, 4, 6, 6], 1000],
    [[2, 2, 2, 1, 1], 400], // pair of 1s counts 100 each
    [[1, 1, 1, 6, 6], 1600], // three 1s count 1000
    [[1, 1, 1, 4, 4], 1400],
  ])("%j scores %i", (dice, expected) => {
    expect(points(dice)).toBe(expected);
  });

  it("names the combo", () => {
    expect(scoreSelection([3, 3, 3, 6, 6])?.combos.map((c) => c.kind)).toEqual(["full-house"]);
  });
});

describe("several combos from one roll", () => {
  it("adds them up", () => {
    expect(points([4, 4, 4, 1, 5])).toBe(550);
    expect(points([1, 1, 1, 1, 5])).toBe(2050);
  });

  it("picks the best way to group the same dice", () => {
    // Full house 1000 + 500 beats three 1s + two 5s (1000 + 100).
    expect(points([1, 1, 1, 5, 5])).toBe(1500);
    // 5-run beats a 4-run plus a single.
    expect(points([1, 2, 3, 4, 5])).toBe(500);
  });
});

describe("invalid selections", () => {
  it.each([[[]], [[2]], [[2, 3]], [[2, 2]], [[1, 2]], [[1, 2, 3]], [[5, 6, 6]]])("%j is not valid", (dice) => {
    expect(scoreSelection(dice)).toBeNull();
  });

  it("rejects faces outside 1-6", () => {
    expect(() => scoreSelection([0])).toThrow(RangeError);
    expect(() => scoreSelection([7])).toThrow(RangeError);
  });
});

describe("hasAnyScore", () => {
  it.each([
    [[2, 3, 4, 6, 6], false],
    [[2, 2, 3, 4, 6], false],
    [[2, 3], false],
    [[6], false],
    [[2, 2, 2, 3, 4], true],
    [[6, 4, 2, 3, 5], true],
    [[1], true],
  ])("%j -> %s", (roll, expected) => {
    expect(hasAnyScore(roll)).toBe(expected);
  });

  it("agrees with a full search over every possible roll of 1-5 dice", () => {
    for (let n = 1; n <= 5; n++) {
      for (let code = 0; code < 6 ** n; code++) {
        const roll: Face[] = [];
        let c = code;
        for (let i = 0; i < n; i++) {
          roll.push(((c % 6) + 1) as Face);
          c = Math.floor(c / 6);
        }
        expect(hasAnyScore(roll), JSON.stringify(roll)).toBe(bestSelection(roll) !== null);
      }
    }
  });
});

describe("bestSelection", () => {
  it("finds the highest-scoring dice to keep", () => {
    expect(bestSelection([1, 1, 1, 5, 5])).toMatchObject({ points: 1500, indices: [0, 1, 2, 3, 4] });
    expect(bestSelection([2, 3, 6, 1, 4])?.points).toBe(250);
  });

  it("returns null on a crap-out", () => {
    expect(bestSelection([2, 3, 4, 6, 6])).toBeNull();
  });
});
