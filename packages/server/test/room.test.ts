import { describe, expect, it } from "vitest";
import { Room, type Member, type Result } from "../src/room.ts";

/** A room whose dice come from a script, so tests control every roll. */
function setup(maxPlayers = 3) {
  let time = 1_000;
  let nextId = 0;
  const faces: number[] = [];
  const room = new Room("ABCD", maxPlayers, {
    random: () => {
      const face = faces.shift();
      if (face === undefined) throw new Error("Ran out of scripted dice");
      return (face - 1) / 6 + 0.01;
    },
    now: () => time,
    newId: () => `id${nextId++}`,
  });
  return {
    room,
    script: (...f: number[]) => faces.push(...f),
    tick: (ms: number) => (time += ms),
  };
}

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function seat(room: Room, ...names: string[]): Member[] {
  return names.map((n) => ok(room.join(n)));
}

describe("lobby", () => {
  it("the first to join is host", () => {
    const { room } = setup();
    const [a, b] = seat(room, "Ann", "Ben");
    expect(room.hostId).toBe(a!.id);
    expect(room.view().members.map((m) => m.name)).toEqual(["Ann", "Ben"]);
    expect(b!.token).not.toBe(a!.token);
  });

  it("refuses joins once full", () => {
    const { room } = setup(2);
    seat(room, "Ann", "Ben");
    expect(room.join("Cat")).toMatchObject({ ok: false, error: "That game is full." });
  });

  it("needs a name and keeps names unique", () => {
    const { room } = setup(4);
    expect(room.join("   ").ok).toBe(false);
    seat(room, "Ann", "ann", "Ann");
    expect(room.view().members.map((m) => m.name)).toEqual(["Ann", "ann 2", "Ann 3"]);
  });

  it("caps names at 20 characters", () => {
    const { room } = setup();
    const [a] = seat(room, "A very very long name indeed");
    expect(a!.name).toHaveLength(20);
  });

  it("clamps seats to 2-5", () => {
    expect(setup(1).room.maxPlayers).toBe(2);
    expect(setup(9).room.maxPlayers).toBe(5);
  });

  it("only the host can start, with at least two players", () => {
    const { room } = setup();
    const [a] = seat(room, "Ann");
    expect(room.start(a!.id).ok).toBe(false);
    const [b] = seat(room, "Ben");
    expect(room.start(b!.id)).toMatchObject({ ok: false, error: "Only the host can start the game." });
    ok(room.start(a!.id));
    expect(room.status).toBe("playing");
    expect(room.game?.players.map((p) => p.name)).toEqual(["Ann", "Ben"]);
  });

  it("no joining after the game starts", () => {
    const { room } = setup();
    const [a] = seat(room, "Ann", "Ben");
    ok(room.start(a!.id));
    expect(room.join("Cat")).toMatchObject({ ok: false, error: "That game has already started." });
  });

  it("leaving the lobby frees the seat and passes host on", () => {
    const { room } = setup();
    const [a, b] = seat(room, "Ann", "Ben");
    room.leave(a!.id);
    expect(room.members.map((m) => m.name)).toEqual(["Ben"]);
    expect(room.hostId).toBe(b!.id);
  });
});

describe("rejoining", () => {
  it("resumes a seat with the right token", () => {
    const { room } = setup();
    const [a] = seat(room, "Ann");
    room.setConnected(a!.id, false);
    expect(room.view().members[0]?.connected).toBe(false);
    ok(room.resume(a!.id, a!.token));
    expect(room.view().members[0]?.connected).toBe(true);
  });

  it("refuses a wrong token", () => {
    const { room } = setup();
    const [a] = seat(room, "Ann");
    expect(room.resume(a!.id, "nope").ok).toBe(false);
  });

  it("leaving mid-game keeps the seat but shows it as away", () => {
    const { room } = setup();
    const [a, b] = seat(room, "Ann", "Ben");
    ok(room.start(a!.id));
    room.leave(a!.id);
    expect(room.members).toHaveLength(2);
    expect(room.view().members[0]?.connected).toBe(false);
    expect(room.hostId).toBe(b!.id);
  });

  it("is empty once nobody is connected", () => {
    const { room } = setup();
    const [a, b] = seat(room, "Ann", "Ben");
    room.setConnected(a!.id, false);
    expect(room.isEmpty).toBe(false);
    room.setConnected(b!.id, false);
    expect(room.isEmpty).toBe(true);
  });
});

describe("playing", () => {
  function started() {
    const s = setup();
    const [a, b] = seat(s.room, "Ann", "Ben");
    ok(s.room.start(a!.id));
    return { ...s, a: a!, b: b! };
  }

  it("only the current player can act", () => {
    const { room, b, script } = started();
    script(1, 1, 1, 2, 3);
    expect(room.roll(b.id, [])).toMatchObject({ ok: false, error: "It's not your turn." });
  });

  it("rolls on the server and counts rolls", () => {
    const { room, a, script } = started();
    script(1, 1, 1, 2, 3);
    ok(room.roll(a.id, []));
    expect(room.game?.turn?.roll).toEqual([1, 1, 1, 2, 3]);
    expect(room.rollCount).toBe(1);
  });

  it("shares the current player's selection, then clears it on the next roll", () => {
    const { room, a, b, script } = started();
    script(1, 1, 1, 2, 3);
    ok(room.roll(a.id, []));
    ok(room.select(a.id, [0, 1]));
    expect(room.view().selection).toEqual([0, 1]);
    expect(room.select(b.id, [0]).ok).toBe(false);
    expect(room.select(a.id, [9]).ok).toBe(false);
    script(5, 6);
    ok(room.roll(a.id, [0, 1, 2]));
    expect(room.view().selection).toEqual([]);
    expect(room.game?.turn).toMatchObject({ turnPoints: 1000, roll: [5, 6] });
  });

  it("rejects keeping dice that don't score", () => {
    const { room, a, script } = started();
    script(1, 1, 1, 2, 3);
    ok(room.roll(a.id, []));
    expect(room.roll(a.id, [3]).ok).toBe(false);
    expect(room.roll(a.id, "junk").ok).toBe(false);
  });

  it("banking shows the result, then passes play after the pause", () => {
    const { room, a, b, script, tick } = started();
    script(1, 1, 1, 2, 3);
    ok(room.roll(a.id, []));
    ok(room.bank(a.id, [0, 1, 2]));
    expect(room.game?.phase).toBe("turn-over");
    expect(room.view().pauseRemainingMs).toBe(5000);
    tick(2000);
    expect(room.view().pauseRemainingMs).toBe(3000);
    ok(room.advance());
    expect(room.game?.players[room.game.current]?.id).toBe(b.id);
    expect(room.view().pauseRemainingMs).toBeNull();
  });

  it("the player up next can skip the pause; others can't", () => {
    const s = setup();
    const [a, b, c] = seat(s.room, "Ann", "Ben", "Cat");
    ok(s.room.start(a!.id));
    s.script(2, 3, 4, 6, 6);
    ok(s.room.roll(a!.id, [])); // crap out
    expect(s.room.next(c!.id).ok).toBe(false);
    ok(s.room.next(b!.id));
    expect(s.room.game?.current).toBe(1);
  });

  it("finishing the game ends the room and the host can play again", () => {
    const { room, a, b, script } = started();
    // Put Ann one bank away from winning.
    room.game = { ...room.game!, players: room.game!.players.map((p, i) => (i === 0 ? { ...p, score: 9800, onBoard: true } : p)) };
    room.game = { ...room.game, turn: { ...room.game.turn!, limits: { maxTurnPoints: 200, minBank: 0 } } };
    script(1, 1, 3, 4, 6);
    ok(room.roll(a.id, []));
    ok(room.bank(a.id, [0, 1]));
    expect(room.status).toBe("finished");
    expect(room.game?.winnerId).toBe(a.id);
    expect(room.view().pauseRemainingMs).toBeNull();
    expect(room.playAgain(b.id).ok).toBe(false);
    ok(room.playAgain(a.id));
    expect(room.status).toBe("playing");
    expect(room.game?.players.every((p) => p.score === 0)).toBe(true);
  });

  it("the next player can carry on from live dice", () => {
    const { room, a, b, script } = started();
    room.game = { ...room.game!, players: room.game!.players.map((p) => ({ ...p, onBoard: true })) };
    room.game = { ...room.game, turn: { ...room.game.turn!, limits: { maxTurnPoints: 10_000, minBank: 0 } } };
    script(1, 1, 1, 4, 6);
    ok(room.roll(a.id, []));
    ok(room.bank(a.id, [0, 1, 2]));
    ok(room.advance());
    expect(room.game?.phase).toBe("deciding");
    expect(room.choose(a.id, "continue").ok).toBe(false);
    ok(room.choose(b.id, "continue"));
    expect(room.game?.turn).toMatchObject({ turnPoints: 1000, diceToRoll: 2 });
  });
});

describe("saving and restoring", () => {
  it("a restored room carries on exactly where it was", () => {
    const { room, script } = setup();
    const [a, b] = seat(room, "Ann", "Ben");
    ok(room.start(a!.id));
    script(1, 1, 1, 2, 3);
    ok(room.roll(a!.id, []));
    ok(room.select(a!.id, [0, 1, 2]));
    const copy = Room.restore(JSON.parse(JSON.stringify(room.snapshot())), {
      random: () => 0,
      now: () => 1_000,
      newId: () => "x",
    });
    expect(copy.view()).toEqual(room.view());
    expect(copy.resume(b!.id, b!.token).ok).toBe(true);
    ok(copy.bank(a!.id, [0, 1, 2]));
    expect(copy.game?.players[0]?.score).toBe(1000);
  });
});

describe("players who go away", () => {
  function started(names = ["Ann", "Ben", "Cat"]) {
    const s = setup(names.length);
    const members = seat(s.room, ...names);
    ok(s.room.start(members[0]!.id));
    return { ...s, members };
  }

  it("reports how long someone has been away", () => {
    const { room, members, tick } = started();
    room.setConnected(members[1]!.id, false);
    tick(12_000);
    expect(room.view().members[1]).toMatchObject({ connected: false, awayMs: 12_000 });
    expect(room.view().members[0]?.awayMs).toBeNull();
  });

  it("hands the host role on after the host has been away a full minute", () => {
    const { room, members, tick } = started();
    const [a, b] = members;
    room.setConnected(a!.id, false);
    expect(room.nextDeadline()).toBe(1_000 + 60_000);
    tick(59_000);
    room.tick();
    expect(room.hostId).toBe(a!.id);
    tick(1_000);
    room.tick();
    expect(room.hostId).toBe(b!.id);
    // Coming back doesn't take it back.
    ok(room.resume(a!.id, a!.token));
    expect(room.hostId).toBe(b!.id);
  });

  it("skips a disconnected host's seat when handing on to the next connected player", () => {
    const { room, members, tick } = started();
    const [a, b, c] = members;
    room.setConnected(b!.id, false);
    room.setConnected(a!.id, false);
    tick(60_000);
    room.tick();
    expect(room.hostId).toBe(c!.id);
  });

  it("also hands the host on in the lobby", () => {
    const { room, tick } = setup();
    const [a, b] = seat(room, "Ann", "Ben");
    room.setConnected(a!.id, false);
    tick(60_000);
    room.tick();
    expect(room.hostId).toBe(b!.id);
  });

  it("the current player becomes skippable after a minute away", () => {
    const { room, members, tick } = started();
    const [a, b] = members;
    room.setConnected(a!.id, false);
    expect(room.view().stuck).toBeNull();
    expect(room.skipTurn(b!.id).ok).toBe(false);
    tick(60_000);
    expect(room.view().stuck).toEqual({ playerId: a!.id, votes: [], voters: [b!.id, members[2]!.id] });
    ok(room.skipTurn(b!.id));
    expect(room.game?.players[room.game.current]?.id).toBe(b!.id);
    expect(room.game?.history.at(-1)?.outcome).toBe("skipped");
    expect(room.view().stuck).toBeNull();
  });

  it("the away player can't be skipped by themselves, and players back in time aren't skippable", () => {
    const { room, members, tick } = started();
    const [a] = members;
    room.setConnected(a!.id, false);
    tick(30_000);
    room.setConnected(a!.id, true);
    tick(60_000);
    expect(room.view().stuck).toBeNull();
  });

  it("removes a player once everyone else connected votes yes", () => {
    const { room, members, tick } = started();
    const [a, b, c] = members;
    room.setConnected(a!.id, false);
    tick(60_000);
    ok(room.voteRemove(b!.id, true));
    expect(room.view().stuck?.votes).toEqual([b!.id]);
    expect(room.members).toHaveLength(3);
    ok(room.voteRemove(b!.id, false)); // change of mind
    expect(room.view().stuck?.votes).toEqual([]);
    ok(room.voteRemove(b!.id, true));
    ok(room.voteRemove(c!.id, true));
    expect(room.members.map((m) => m.name)).toEqual(["Ben", "Cat"]);
    expect(room.game?.players.map((p) => p.name)).toEqual(["Ben", "Cat"]);
    expect(room.game?.players[room.game.current]?.id).toBe(b!.id);
    expect(room.hostId).toBe(b!.id);
    // Their saved seat no longer works.
    expect(room.resume(a!.id, a!.token).ok).toBe(false);
    expect(room.wasRemoved(a!.id)).toBe(true);
  });

  it("only connected players' votes are needed", () => {
    const { room, members, tick } = started();
    const [a, b, c] = members;
    room.setConnected(c!.id, false);
    room.setConnected(a!.id, false);
    tick(60_000);
    ok(room.voteRemove(b!.id, true));
    expect(room.game?.players.map((p) => p.id)).toEqual([b!.id, c!.id]);
  });

  it("votes reset if the away player comes back", () => {
    const { room, members, tick } = started();
    const [a, b] = members;
    room.setConnected(a!.id, false);
    tick(60_000);
    ok(room.voteRemove(b!.id, true));
    ok(room.resume(a!.id, a!.token));
    room.setConnected(a!.id, false);
    tick(60_000);
    expect(room.view().stuck?.votes).toEqual([]);
  });

  it("removing one of two players ends the game with the other winning", () => {
    const { room, members, tick } = started(["Ann", "Ben"]);
    const [a, b] = members;
    room.setConnected(a!.id, false);
    tick(60_000);
    ok(room.voteRemove(b!.id, true));
    expect(room.status).toBe("finished");
    expect(room.game).toMatchObject({ winnerId: b!.id, endReason: "last-player" });
  });

  it("restores older saved rooms without the new fields", () => {
    const { room } = setup();
    seat(room, "Ann", "Ben");
    const old = JSON.parse(JSON.stringify(room.snapshot()));
    delete old.removedIds;
    delete old.removeVotes;
    for (const m of old.members) delete m.awaySince;
    const copy = Room.restore(old, { random: () => 0, now: () => 5_000, newId: () => "x" });
    copy.setConnected(old.members[0].id, false);
    expect(copy.view().members[0]?.awayMs).toBe(0);
    expect(copy.view().stuck).toBeNull();
  });
});
