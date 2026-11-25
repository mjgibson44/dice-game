/**
 * One online game room: seats, lobby, and the authoritative game state.
 * No sockets or timers in here, so it's easy to test. The server calls these
 * methods, then broadcasts `view()` and schedules `advance()` from `pauseEndsAt`.
 */

import {
  bankTurn,
  chooseStart,
  createGame,
  currentPlayer,
  keep,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  nextTurn,
  roll,
  rollDice,
  TURN_OVER_PAUSE_MS,
  type GameResult,
  type GameState,
  type RoomStatus,
  type RoomView,
} from "@dice-game/shared";

export interface Member {
  id: string;
  name: string;
  /** Secret that lets this member rejoin their seat after a disconnect. */
  token: string;
  connected: boolean;
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export interface RoomDeps {
  /** Uniform random number in [0, 1) for dice. */
  random: () => number;
  now: () => number;
  newId: () => string;
}

export function cleanName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

export class Room {
  readonly code: string;
  hostId = "";
  readonly maxPlayers: number;
  status: RoomStatus = "lobby";
  members: Member[] = [];
  game: GameState | null = null;
  selection: number[] = [];
  rollCount = 0;
  /** When the finished turn on show should pass to the next player, or null. */
  pauseEndsAt: number | null = null;

  private readonly deps: RoomDeps;

  constructor(code: string, maxPlayers: number, deps: RoomDeps) {
    this.deps = deps;
    this.code = code;
    this.maxPlayers = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.round(maxPlayers)));
  }

  /** Take a seat. Only possible in the lobby while there's room. */
  join(rawName: string): Result<Member> {
    if (this.status !== "lobby") return fail("That game has already started.");
    if (this.members.length >= this.maxPlayers) return fail("That game is full.");
    const base = cleanName(rawName);
    if (!base) return fail("Enter a name first.");
    const member: Member = { id: this.deps.newId(), name: this.uniqueName(base), token: this.deps.newId(), connected: true };
    this.members.push(member);
    if (!this.hostId) this.hostId = member.id;
    return ok(member);
  }

  /** Reclaim a seat after a disconnect or page reload. */
  resume(playerId: string, token: string): Result<Member> {
    const member = this.members.find((m) => m.id === playerId);
    if (!member || member.token !== token) return fail("You're no longer in that game.");
    member.connected = true;
    return ok(member);
  }

  setConnected(playerId: string, connected: boolean) {
    const member = this.members.find((m) => m.id === playerId);
    if (member) member.connected = connected;
  }

  /**
   * Leave for good. In the lobby the seat opens up; once a game has started
   * the seat stays (so turn order and scores hold) and just shows as away.
   */
  leave(playerId: string) {
    if (this.status === "lobby") {
      this.members = this.members.filter((m) => m.id !== playerId);
      if (this.hostId === playerId) this.hostId = this.members[0]?.id ?? "";
    } else {
      this.setConnected(playerId, false);
      if (this.hostId === playerId) this.hostId = this.members.find((m) => m.connected)?.id ?? this.hostId;
    }
  }

  get isEmpty(): boolean {
    return this.members.every((m) => !m.connected);
  }

  start(by: string): Result {
    if (by !== this.hostId) return fail("Only the host can start the game.");
    if (this.status !== "lobby") return fail("The game has already started.");
    if (this.members.length < MIN_PLAYERS) return fail(`Waiting for at least ${MIN_PLAYERS} players.`);
    this.beginGame();
    return ok(undefined);
  }

  playAgain(by: string): Result {
    if (by !== this.hostId) return fail("Only the host can start a new game.");
    if (this.status !== "finished") return fail("The game isn't over yet.");
    this.beginGame();
    return ok(undefined);
  }

  private beginGame() {
    this.game = createGame(this.members.map(({ id, name }) => ({ id, name })));
    this.status = "playing";
    this.selection = [];
    this.pauseEndsAt = null;
  }

  /** The current player's live dice selection, shown to everyone. */
  select(by: string, indices: unknown): Result {
    const turnCheck = this.requireTurn(by);
    if (!turnCheck.ok) return turnCheck;
    const roll = this.game!.turn?.roll;
    if (this.game!.turn?.phase !== "choosing" || !roll) return fail("There's nothing to select.");
    if (!isIndexList(indices, roll.length)) return fail("Invalid dice selection.");
    this.selection = [...new Set(indices)];
    return ok(undefined);
  }

  roll(by: string, keepIndices: unknown): Result {
    const turnCheck = this.requireTurn(by);
    if (!turnCheck.ok) return turnCheck;
    let game = this.game!;
    if (game.turn?.phase === "choosing") {
      if (!isIndexList(keepIndices, game.turn.roll?.length ?? 0)) return fail("Invalid dice selection.");
      const kept = keep(game, keepIndices);
      if (!kept.ok) return kept;
      game = kept.state;
    }
    if (!game.turn) return fail("You can't roll right now.");
    const rolled = roll(game, rollDice(game.turn.diceToRoll, this.deps.random));
    if (!rolled.ok) return rolled;
    this.rollCount += 1;
    return this.commit(rolled);
  }

  bank(by: string, keepIndices: unknown): Result {
    const turnCheck = this.requireTurn(by);
    if (!turnCheck.ok) return turnCheck;
    let game = this.game!;
    if (game.turn?.phase === "choosing") {
      if (!isIndexList(keepIndices, game.turn.roll?.length ?? 0)) return fail("Invalid dice selection.");
      const kept = keep(game, keepIndices);
      if (!kept.ok) return kept;
      game = kept.state;
    }
    return this.commit(bankTurn(game));
  }

  choose(by: string, choice: unknown): Result {
    const turnCheck = this.requireTurn(by);
    if (!turnCheck.ok) return turnCheck;
    if (choice !== "fresh" && choice !== "continue") return fail("Choose fresh or continue.");
    return this.commit(chooseStart(this.game!, choice));
  }

  /** Skip the rest of the pause. The player who just went or the one up next can do this. */
  next(by: string): Result {
    const game = this.game;
    if (!game || game.phase !== "turn-over") return fail("The turn isn't over yet.");
    const upNext = game.players[(game.current + 1) % game.players.length]!;
    if (by !== currentPlayer(game).id && by !== upNext.id) return fail("It's not your turn.");
    return this.advance();
  }

  /** Pass play to the next player once a finished turn has been on show. */
  advance(): Result {
    if (!this.game || this.game.phase !== "turn-over") return fail("The turn isn't over yet.");
    return this.commit(nextTurn(this.game));
  }

  private requireTurn(by: string): Result {
    if (!this.game || this.status !== "playing") return fail("The game isn't running.");
    if (currentPlayer(this.game).id !== by) return fail("It's not your turn.");
    if (this.game.phase === "turn-over" || this.game.phase === "finished") return fail("Your turn is over.");
    return ok(undefined);
  }

  private commit(result: GameResult): Result {
    if (!result.ok) return result;
    this.game = result.state;
    this.selection = [];
    this.pauseEndsAt = this.game.phase === "turn-over" ? this.deps.now() + TURN_OVER_PAUSE_MS : null;
    if (this.game.phase === "finished") this.status = "finished";
    return ok(undefined);
  }

  private uniqueName(base: string): string {
    const taken = new Set(this.members.map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const name = `${base.slice(0, MAX_NAME_LENGTH - 3)} ${n}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  view(): RoomView {
    return {
      code: this.code,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      status: this.status,
      members: this.members.map(({ id, name, connected }) => ({ id, name, connected })),
      game: this.game,
      selection: this.selection,
      rollCount: this.rollCount,
      pauseRemainingMs: this.pauseEndsAt === null ? null : Math.max(0, this.pauseEndsAt - this.deps.now()),
    };
  }
}

function isIndexList(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= length &&
    value.every((i) => Number.isInteger(i) && i >= 0 && i < length)
  );
}
