/**
 * One online game room: seats, lobby, and the authoritative game state.
 * No sockets or timers in here, so it's easy to test. The server calls these
 * methods, broadcasts `view()`, and calls `tick()` at `nextDeadline()` for
 * anything time-based (turn-over pause, host handoff, away players).
 */

import {
  AWAY_LIMIT_MS,
  bankTurn,
  chooseStart,
  createGame,
  currentPlayer,
  keep,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  nextTurn,
  removePlayer,
  roll,
  rollDice,
  skipTurn,
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
  /** When they dropped off, or null while connected. */
  awaySince?: number | null;
}

interface RemoveVotes {
  targetId: string;
  voters: string[];
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

/** Everything needed to rebuild a room after the server sleeps or restarts. */
export interface RoomSnapshot {
  code: string;
  hostId: string;
  maxPlayers: number;
  status: RoomStatus;
  members: Member[];
  game: GameState | null;
  selection: number[];
  rollCount: number;
  pauseEndsAt: number | null;
  removedIds?: string[];
  removeVotes?: RemoveVotes | null;
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
  /** Players voted out; their saved seats no longer work. */
  removedIds: string[] = [];
  removeVotes: RemoveVotes | null = null;

  private readonly deps: RoomDeps;

  constructor(code: string, maxPlayers: number, deps: RoomDeps) {
    this.deps = deps;
    this.code = code;
    this.maxPlayers = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.round(maxPlayers)));
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      status: this.status,
      members: this.members,
      game: this.game,
      selection: this.selection,
      rollCount: this.rollCount,
      pauseEndsAt: this.pauseEndsAt,
      removedIds: this.removedIds,
      removeVotes: this.removeVotes,
    };
  }

  static restore(snapshot: RoomSnapshot, deps: RoomDeps): Room {
    const room = new Room(snapshot.code, snapshot.maxPlayers, deps);
    room.hostId = snapshot.hostId;
    room.status = snapshot.status;
    room.members = snapshot.members;
    room.game = snapshot.game;
    room.selection = snapshot.selection;
    room.rollCount = snapshot.rollCount;
    room.pauseEndsAt = snapshot.pauseEndsAt;
    room.removedIds = snapshot.removedIds ?? [];
    room.removeVotes = snapshot.removeVotes ?? null;
    return room;
  }

  /** Take a seat. Only possible in the lobby while there's room. */
  join(rawName: string): Result<Member> {
    if (this.status !== "lobby") return fail("That game has already started.");
    if (this.members.length >= this.maxPlayers) return fail("That game is full.");
    const base = cleanName(rawName);
    if (!base) return fail("Enter a name first.");
    const member: Member = {
      id: this.deps.newId(),
      name: this.uniqueName(base),
      token: this.deps.newId(),
      connected: true,
      awaySince: null,
    };
    this.members.push(member);
    if (!this.hostId) this.hostId = member.id;
    return ok(member);
  }

  /** Reclaim a seat after a disconnect or page reload. */
  resume(playerId: string, token: string): Result<Member> {
    const member = this.members.find((m) => m.id === playerId);
    if (!member || member.token !== token) return fail("You're no longer in that game.");
    this.setConnected(playerId, true);
    return ok(member);
  }

  wasRemoved(playerId: string): boolean {
    return this.removedIds.includes(playerId);
  }

  setConnected(playerId: string, connected: boolean) {
    const member = this.members.find((m) => m.id === playerId);
    if (!member) return;
    if (connected) {
      member.awaySince = null;
      // They're back: any vote to remove them is off.
      if (this.removeVotes?.targetId === playerId) this.removeVotes = null;
    } else if (member.connected || member.awaySince == null) {
      member.awaySince = this.deps.now();
    }
    member.connected = connected;
  }

  private awayFor(member: Member): number {
    return member.connected || member.awaySince == null ? 0 : this.deps.now() - member.awaySince;
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
      if (this.hostId === playerId) this.passHost();
    }
  }

  /** Make the next connected player (in seat order after the current host) the host. */
  private passHost() {
    const from = Math.max(0, this.members.findIndex((m) => m.id === this.hostId));
    for (let step = 1; step <= this.members.length; step++) {
      const candidate = this.members[(from + step) % this.members.length]!;
      if (candidate.connected && candidate.id !== this.hostId) {
        this.hostId = candidate.id;
        return;
      }
    }
  }

  /** The current player, if they've been away long enough for others to skip or remove them. */
  stuckPlayer(): Member | null {
    const game = this.game;
    if (!game || this.status !== "playing" || (game.phase !== "playing" && game.phase !== "deciding")) return null;
    const member = this.members.find((m) => m.id === currentPlayer(game).id);
    return member && !member.connected && this.awayFor(member) >= AWAY_LIMIT_MS ? member : null;
  }

  /** Connected players other than `excludeId`: everyone whose vote counts. */
  private votersExcept(excludeId: string): string[] {
    return this.members.filter((m) => m.connected && m.id !== excludeId).map((m) => m.id);
  }

  /** Handle anything that's come due: the turn-over pause ending, or the host being away too long. */
  tick() {
    const now = this.deps.now();
    if (this.pauseEndsAt !== null && now >= this.pauseEndsAt) this.advance();
    const host = this.members.find((m) => m.id === this.hostId);
    if (host && !host.connected && this.awayFor(host) >= AWAY_LIMIT_MS) this.passHost();
  }

  /** When `tick()` next has something to do (or the current player becomes skippable), or null. */
  nextDeadline(): number | null {
    const times: number[] = [];
    if (this.pauseEndsAt !== null) times.push(this.pauseEndsAt);
    const awayDeadline = (m: Member | undefined) => {
      if (m && !m.connected && m.awaySince != null && this.awayFor(m) < AWAY_LIMIT_MS) times.push(m.awaySince + AWAY_LIMIT_MS);
    };
    const host = this.members.find((m) => m.id === this.hostId);
    if (host && this.members.some((m) => m.connected && m.id !== host.id)) awayDeadline(host);
    if (this.game && (this.game.phase === "playing" || this.game.phase === "deciding")) {
      awayDeadline(this.members.find((m) => m.id === currentPlayer(this.game!).id));
    }
    return times.length ? Math.min(...times) : null;
  }

  /** Skip the turn of a player who's been away too long. Anyone else connected can do this. */
  skipTurn(by: string): Result {
    const stuck = this.stuckPlayer();
    if (!stuck) return fail("Nobody needs skipping right now.");
    if (!this.votersExcept(stuck.id).includes(by)) return fail("You can't skip this turn.");
    return this.commit(skipTurn(this.game!));
  }

  /** Vote to remove a player who's been away too long. They're out once everyone else connected agrees. */
  voteRemove(by: string, vote: unknown): Result {
    const stuck = this.stuckPlayer();
    if (!stuck) return fail("Nobody needs removing right now.");
    const voters = this.votersExcept(stuck.id);
    if (!voters.includes(by)) return fail("You can't vote on this.");
    const current = this.removeVotes?.targetId === stuck.id ? this.removeVotes.voters : [];
    const next = vote === true ? [...new Set([...current, by])] : current.filter((id) => id !== by);
    this.removeVotes = { targetId: stuck.id, voters: next };
    if (voters.every((id) => next.includes(id))) return this.removeMember(stuck.id);
    return ok(undefined);
  }

  private removeMember(playerId: string): Result {
    const result = this.commit(removePlayer(this.game!, playerId));
    if (!result.ok) return result;
    if (this.hostId === playerId) this.passHost();
    this.members = this.members.filter((m) => m.id !== playerId);
    this.removedIds.push(playerId);
    this.removeVotes = null;
    return ok(undefined);
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
    // Votes are about the player whose turn it is; a new turn starts the count over.
    if (this.removeVotes && this.removeVotes.targetId !== currentPlayer(this.game).id) this.removeVotes = null;
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
      members: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        connected: m.connected,
        awayMs: m.connected ? null : this.awayFor(m),
      })),
      game: this.game,
      selection: this.selection,
      rollCount: this.rollCount,
      pauseRemainingMs: this.pauseEndsAt === null ? null : Math.max(0, this.pauseEndsAt - this.deps.now()),
      stuck: this.stuckView(),
    };
  }

  private stuckView(): RoomView["stuck"] {
    const stuck = this.stuckPlayer();
    if (!stuck) return null;
    return {
      playerId: stuck.id,
      votes: this.removeVotes?.targetId === stuck.id ? this.removeVotes.voters : [],
      voters: this.votersExcept(stuck.id),
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
