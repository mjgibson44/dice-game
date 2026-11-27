import { describe, expect, it } from "vitest";
import {
  bankTurn,
  chooseStart,
  createGame,
  currentPlayer,
  keep,
  nextTurn,
  removePlayer,
  roll,
  skipTurn,
  type GameResult,
  type GameState,
} from "../src/game.ts";
import type { Face } from "../src/scoring.ts";

function ok(result: GameResult): GameState {
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

/** Roll the given faces, then keep the dice at `indices`. */
const rollKeep = (s: GameState, faces: Face[], indices: number[]) => ok(keep(ok(roll(s, faces)), indices));
const next = (s: GameState) => ok(nextTurn(s));

function newGame(names: string[], setup: Record<string, { score?: number; onBoard?: boolean }> = {}): GameState {
  return createGame(names.map((n) => ({ id: n, name: n, ...setup[n] })));
}

const onBoard = { onBoard: true };

describe("taking turns", () => {
  it("starts with the first player rolling five fresh dice", () => {
    const g = createGame([{ id: "A", name: "A" }, { id: "B", name: "B" }]);
    expect(g.phase).toBe("playing");
    expect(currentPlayer(g).id).toBe("A");
    expect(g.turn).toMatchObject({ diceToRoll: 5, turnPoints: 0 });
  });

  it("a crap-out passes play on with no live dice", () => {
    let g = newGame(["A", "B"], { A: onBoard, B: onBoard });
    g = ok(roll(g, [2, 3, 4, 6, 6]));
    expect(g.phase).toBe("turn-over");
    expect(g.live).toBeNull();
    g = next(g);
    expect(currentPlayer(g).id).toBe("B");
    expect(g.phase).toBe("playing");
    expect(g.turn?.diceToRoll).toBe(5);
  });

  it("wraps around to the first player", () => {
    let g = newGame(["A", "B"]);
    g = next(ok(roll(g, [2, 3, 4, 6, 6])));
    g = next(ok(roll(g, [2, 3, 4, 6, 6])));
    expect(currentPlayer(g).id).toBe("A");
    expect(g.turnNumber).toBe(3);
  });
});

describe("getting on the board (350 opening)", () => {
  it("can't bank under 350 before getting on the board", () => {
    const g = rollKeep(newGame(["A", "B"]), [1, 1, 1, 2, 3], [0, 1]); // 200
    expect(bankTurn(g)).toMatchObject({ ok: false });
  });

  it("can bank 350 or more to get on the board", () => {
    let g = rollKeep(newGame(["A", "B"]), [1, 1, 1, 2, 3], [0, 1, 2]); // 1000
    g = ok(bankTurn(g));
    expect(g.players[0]).toMatchObject({ score: 1000, onBoard: true });
  });

  it("exactly 350 is enough", () => {
    let g = rollKeep(newGame(["A", "B"]), [3, 3, 3, 5, 2], [0, 1, 2, 3]); // 350
    g = ok(bankTurn(g));
    expect(g.players[0]).toMatchObject({ score: 350, onBoard: true });
  });

  it("once on the board, any bank counts", () => {
    let g = rollKeep(newGame(["A"], { A: onBoard }), [5, 2, 3, 4, 6], [0]);
    g = ok(bankTurn(g));
    expect(g.players[0]?.score).toBe(50);
  });

  it("live dice are dead for a player who isn't on the board", () => {
    let g = rollKeep(newGame(["A", "B"], { A: onBoard }), [1, 1, 1, 4, 6], [0, 1, 2]);
    g = next(ok(bankTurn(g)));
    expect(g.phase).toBe("playing");
    expect(g.deadDice).toBe("not-on-board");
    expect(g.turn).toMatchObject({ diceToRoll: 5, turnPoints: 0 });
  });
});

describe("live dice (the A/B/C/D example from the rules)", () => {
  it("plays out the example", () => {
    let g = newGame(["A", "B", "C", "D"], { A: onBoard, B: onBoard, C: onBoard, D: onBoard });

    // Person A: 1,1,1,4,5 keeps three 1s (1000), rolls two dice, gets a 1 (1100), banks.
    g = rollKeep(g, [1, 1, 1, 4, 5], [0, 1, 2]);
    g = rollKeep(g, [1, 3], [0]);
    g = ok(bankTurn(g));
    expect(g.players[0]?.score).toBe(1100);
    expect(g.live).toEqual({ fromPlayerId: "A", turnPoints: 1100, diceToRoll: 1 });

    // Person B: carries on from 1100 with one live die, rolls a 5 (1150): hot dice.
    g = next(g);
    expect(g.phase).toBe("deciding");
    g = ok(chooseStart(g, "continue"));
    expect(g.turn).toMatchObject({ turnPoints: 1100, inheritedPoints: 1100, diceToRoll: 1 });
    g = rollKeep(g, [5], [0]);
    expect(g.turn).toMatchObject({ turnPoints: 1150, diceToRoll: 5 });
    // Rolls 2,3,4,5 (small straight, 250) -> 1400, banks.
    g = rollKeep(g, [2, 3, 4, 5, 2], [0, 1, 2, 3]);
    g = ok(bankTurn(g));
    expect(g.players[1]?.score).toBe(1400);
    expect(g.live).toMatchObject({ turnPoints: 1400, diceToRoll: 1 });

    // Person C: carries on from 1400, rolls a 6 on the live die. Nothing scores.
    g = next(g);
    g = ok(chooseStart(g, "continue"));
    g = ok(roll(g, [6]));
    expect(g.phase).toBe("turn-over");
    expect(g.players[2]?.score).toBe(0);
    expect(g.live).toBeNull();
  });

  it("a player can start fresh instead of taking the live dice", () => {
    let g = newGame(["C", "D"], { C: onBoard, D: onBoard });
    // Person C: rolls a 1, takes 4 dice and rolls three 4s, banks 500.
    g = rollKeep(g, [1, 2, 3, 6, 6], [0]);
    g = rollKeep(g, [4, 4, 4, 2], [0, 1, 2]);
    g = ok(bankTurn(g));
    expect(g.live).toMatchObject({ turnPoints: 500, diceToRoll: 1 });
    // Person D decides 500 isn't enough and rolls all five fresh.
    g = ok(chooseStart(next(g), "fresh"));
    expect(g.turn).toMatchObject({ turnPoints: 0, inheritedPoints: 0, diceToRoll: 5 });
  });

  it("banking after hot dice passes all five dice on", () => {
    let g = newGame(["A", "B"], { A: onBoard, B: onBoard });
    g = rollKeep(g, [1, 1, 1, 5, 5], [0, 1, 2, 3, 4]); // 1500, hot dice
    g = ok(bankTurn(g));
    expect(g.live).toMatchObject({ turnPoints: 1500, diceToRoll: 5 });
    g = ok(chooseStart(next(g), "continue"));
    expect(g.turn).toMatchObject({ turnPoints: 1500, diceToRoll: 5 });
  });

  it("can't choose a start when there are no live dice", () => {
    expect(chooseStart(newGame(["A"]), "continue").ok).toBe(false);
  });
});

describe("winning on exactly 10,000", () => {
  const at9800 = () => newGame(["A", "B"], { A: { score: 9800, onBoard: true }, B: onBoard });

  it("can't set aside dice that would go over", () => {
    const g = ok(roll(at9800(), [1, 1, 1, 2, 3]));
    expect(keep(g, [0, 1, 2])).toMatchObject({ ok: false }); // 1000 is over
    expect(keep(g, [0])).toMatchObject({ ok: true }); // 100 leaves room to keep rolling
  });

  it("can't pick out dice to land on 10,000 when the whole roll scores more", () => {
    // Three 1s show 1000: two of them would make exactly 200, but every scoring die counts.
    expect(keep(ok(roll(at9800(), [1, 1, 1, 2, 3])), [0, 1])).toMatchObject({ ok: false });
    // 1, 1, 5 show 250: the two 1s can't finish it either.
    const g = ok(roll(at9800(), [1, 1, 5, 4, 4]));
    expect(keep(g, [0, 1])).toMatchObject({ ok: false });
    expect(keep(g, [0, 2])).toMatchObject({ ok: true }); // 150, keep rolling
  });

  it("lands on 10,000 when the whole roll scores exactly what's needed", () => {
    let g = rollKeep(at9800(), [1, 1, 3, 4, 6], [0, 1]); // the roll shows exactly 200
    g = ok(bankTurn(g));
    expect(g.phase).toBe("finished");
    expect(g.winnerId).toBe("A");
    expect(g.players[0]?.score).toBe(10_000);
  });

  it("plays out the 9800 example: one 1, then a 5, then a single 5 to win", () => {
    let g = rollKeep(at9800(), [1, 1, 1, 2, 3], [0]); // 9900
    g = rollKeep(g, [5, 2, 3, 4], [0]); // 9950, three dice left
    g = rollKeep(g, [5, 2, 3], [0]); // a single 5 -> 10,000
    g = ok(bankTurn(g));
    expect(g.phase).toBe("finished");
    expect(g.winnerId).toBe("A");
    expect(g.players[0]?.score).toBe(10_000);
  });

  it("needing 50, two 5s end the turn with nothing", () => {
    let g = rollKeep(at9800(), [1, 1, 1, 2, 3], [0]);
    g = rollKeep(g, [5, 2, 3, 4], [0]); // 9950, needs exactly 50
    g = ok(roll(g, [5, 5, 2]));
    expect(g.phase).toBe("turn-over");
    expect(g.turn?.crapOutReason).toBe("not-exact");
    expect(g.players[0]?.score).toBe(9800);
  });

  it("plays out the 1, 1, 5, 4, 4 example: keep 1 and 5, then 1, 5, 4 craps out", () => {
    let g = rollKeep(at9800(), [1, 1, 5, 4, 4], [0, 2]); // 150, three dice left, needs 50
    g = ok(roll(g, [1, 5, 4])); // the 5 alone would finish, but the 1 counts too
    expect(g.phase).toBe("turn-over");
    expect(g.turn?.crapOutReason).toBe("not-exact");
    expect(g.players[0]?.score).toBe(9800);
  });

  it("can still set aside less and keep rolling when the roll scores more than needed", () => {
    let g = rollKeep(at9800(), [1, 2, 3, 4, 6], [0]); // 100, four dice left, needs 100
    g = ok(roll(g, [5, 5, 2, 3])); // shows 100: two 5s land on it exactly
    expect(keep(g, [0, 1])).toMatchObject({ ok: true });
    expect(keep(g, [0])).toMatchObject({ ok: true }); // or just one, and roll on
  });

  it("a roll where every scoring choice goes over ends the turn with nothing", () => {
    let g = rollKeep(at9800(), [1, 1, 1, 2, 3], [0]);
    g = rollKeep(g, [5, 2, 3, 4], [0]); // 9950, needs exactly 50
    g = ok(roll(g, [1, 2, 3]));
    expect(g.phase).toBe("turn-over");
    expect(g.turn?.crapOutReason).toBe("over-target");
    expect(g.players[0]?.score).toBe(9800);
  });

  it("live dice are dead when they'd leave no room under 10,000", () => {
    let g = newGame(["A", "B"], { A: onBoard, B: { score: 9000, onBoard: true } });
    g = rollKeep(g, [1, 1, 1, 2, 3], [0, 1, 2]); // 1000
    g = next(ok(bankTurn(g)));
    expect(g.deadDice).toBe("no-room");
    expect(g.turn?.turnPoints).toBe(0);
  });

  it("the game can't continue after someone wins", () => {
    let g = rollKeep(at9800(), [1, 1, 3, 4, 6], [0, 1]);
    g = ok(bankTurn(g));
    expect(g.phase).toBe("finished");
    expect(nextTurn(g).ok).toBe(false);
  });
});

describe("skipping and removing players", () => {
  const three = () => newGame(["A", "B", "C"], { A: onBoard, B: onBoard, C: onBoard });

  it("skipping ends the turn with nothing and passes to the next player", () => {
    let g = rollKeep(three(), [1, 1, 1, 2, 3], [0, 1, 2]); // A has 1000 on the table
    g = ok(skipTurn(g));
    expect(currentPlayer(g).id).toBe("B");
    expect(g.phase).toBe("playing");
    expect(g.players[0]?.score).toBe(0);
    expect(g.history.at(-1)).toMatchObject({ playerId: "A", outcome: "skipped", points: 0 });
  });

  it("skipping someone deciding about live dice drops the live dice", () => {
    let g = rollKeep(three(), [1, 1, 1, 2, 3], [0, 1, 2]);
    g = next(ok(bankTurn(g)));
    expect(g.phase).toBe("deciding");
    g = ok(skipTurn(g));
    expect(currentPlayer(g).id).toBe("C");
    expect(g.live).toBeNull();
    expect(g.phase).toBe("playing");
  });

  it("removing the current player starts the next player's turn", () => {
    const g = ok(removePlayer(rollKeep(three(), [1, 1, 1, 2, 3], [0, 1, 2]), "A"));
    expect(g.players.map((p) => p.id)).toEqual(["B", "C"]);
    expect(currentPlayer(g).id).toBe("B");
    expect(g.turn).toMatchObject({ turnPoints: 0, diceToRoll: 5 });
  });

  it("removing the last seat's current player wraps to the first", () => {
    let g = next(ok(roll(three(), [2, 3, 4, 6, 6])));
    g = next(ok(roll(g, [2, 3, 4, 6, 6])));
    expect(currentPlayer(g).id).toBe("C");
    g = ok(removePlayer(g, "C"));
    expect(currentPlayer(g).id).toBe("A");
  });

  it("removing someone else keeps the current player's turn going", () => {
    let g = next(ok(roll(three(), [2, 3, 4, 6, 6]))); // B's turn
    g = rollKeep(g, [5, 2, 3, 4, 6], [0]);
    g = ok(removePlayer(g, "A"));
    expect(currentPlayer(g).id).toBe("B");
    expect(g.turn?.turnPoints).toBe(50);
  });

  it("removing the player whose live dice are on offer cancels the offer", () => {
    let g = rollKeep(three(), [1, 1, 1, 2, 3], [0, 1, 2]);
    g = next(ok(bankTurn(g))); // B deciding on A's dice
    g = ok(removePlayer(g, "A"));
    expect(g.phase).toBe("playing");
    expect(currentPlayer(g).id).toBe("B");
    expect(g.turn?.turnPoints).toBe(0);
  });

  it("the last player left wins", () => {
    const g = ok(removePlayer(newGame(["A", "B"]), "A"));
    expect(g).toMatchObject({ phase: "finished", winnerId: "B", endReason: "last-player" });
  });

  it("a game won normally says so", () => {
    let g = rollKeep(newGame(["A", "B"], { A: { score: 9800, onBoard: true } }), [1, 1, 3, 4, 6], [0, 1]);
    g = ok(bankTurn(g));
    expect(g.endReason).toBe("target");
  });
});
