/**
 * The game table, shared by practice mode and online games. It only draws
 * the game and reports taps; the wrapper decides what those taps do (apply
 * them locally, or send them to the server).
 */

import {
  bankBlocker,
  currentPlayer,
  DICE_PER_TURN,
  pointsRoom,
  scoreSelection,
  type GameState,
} from "@dice-game/shared";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Die } from "./Die.tsx";
import { previewVolume, setMuted, setVolume, useGameSounds, useMuted, useSoundVolume } from "./sound.ts";

export const fmt = (n: number) => n.toLocaleString("en-US");
const dice = (n: number) => `${n} ${n === 1 ? "die" : "dice"}`;

export interface GameViewProps {
  game: GameState;
  /** Dice shown as selected: yours on your turn, or the current player's while you watch. */
  selected: number[];
  /** Whether this device controls the current turn. */
  myTurn: boolean;
  /** The viewer's player id online, or null in pass-and-play where everyone shares the device. */
  meId: string | null;
  /** Changes on every roll, to replay the roll animation. */
  rollId: number;
  /** When the finished turn on show passes to the next player (a Date.now() time), or null. */
  pauseEndsAt: number | null;
  canSkipPause: boolean;
  /** Players who have dropped off (online only). */
  awayIds?: ReadonlySet<string>;
  error: string | null;
  hintIndices?: readonly number[] | null;
  label: string;
  /** Extra things after a player's name on the scoreboard (the voice badge online). */
  nameBadge?: (playerId: string) => ReactNode;
  /** Extra controls in the top bar, before the menu button (the mic button online). */
  topbarExtra?: ReactNode;
  onToggle: (index: number) => void;
  onRoll: () => void;
  onBank: () => void;
  onChoose: (choice: "fresh" | "continue") => void;
  onNext: () => void;
  onOpenMenu: () => void;
}

export function GameView(props: GameViewProps) {
  const { game, myTurn, meId, rollId, pauseEndsAt, canSkipPause, awayIds, error, hintIndices, label } = props;

  const player = currentPlayer(game);
  const turn = game.turn;
  const { target, openingMin } = game.config;
  const nextPlayer = game.players[(game.current + 1) % game.players.length]!;
  const nameOf = (id: string) => (id === meId ? "You" : (game.players.find((p) => p.id === id)?.name ?? "Someone"));
  const isMe = meId !== null && player.id === meId;
  // Who the messages are about: "You" when it's your device's turn, otherwise their name.
  const who = myTurn ? "You" : player.name;
  const needs = myTurn ? "need" : "needs";

  const choosing = game.phase === "playing" && turn?.phase === "choosing";
  // Ignore picks that don't fit the current roll (a new roll can land before a stale selection clears).
  const rollLength = turn?.roll?.length ?? 0;
  const selected = props.selected.filter((i) => i < rollLength);
  const selectedFaces = choosing && turn.roll ? selected.map((i) => turn.roll![i]!) : [];
  const selection = selectedFaces.length ? scoreSelection(selectedFaces) : null;
  const overTarget = selection !== null && turn !== null && selection.points > pointsRoom(turn);
  const validSelection = selection !== null && !overTarget;

  const diceAfterKeep = turn ? turn.diceToRoll - selected.length || DICE_PER_TURN : DICE_PER_TURN;
  const pendingPoints = (turn?.turnPoints ?? 0) + (validSelection ? selection.points : 0);

  // What banking would do right now, accounting for the dice currently selected.
  const bankReason = (() => {
    if (game.phase !== "playing" || !turn) return "not-playing";
    if (turn.phase === "choosing") {
      if (!validSelection) return "Select scoring dice first.";
      return pendingPoints < turn.limits.minBank ? `Need ${openingMin} to get on the board.` : null;
    }
    return bankBlocker(turn);
  })();
  const canRoll = game.phase === "playing" && (turn?.phase === "ready" || validSelection);

  const lastRecord = game.history.at(-1);
  const turnOver = game.phase === "turn-over";
  const live = game.live;
  const liveFromName = live ? nameOf(live.fromPlayerId) : null;

  const secondsLeft = useSecondsLeft(pauseEndsAt);
  useGameSounds(game, rollId, meId);

  return (
    <main className="app game">
      <header className="topbar">
        <span className="eyebrow">{label}</span>
        <span className="topbar-actions">
          {props.topbarExtra}
          <button type="button" className="menu-button" onClick={props.onOpenMenu} aria-label="Menu">
            <span />
            <span />
            <span />
          </button>
        </span>
      </header>

      <ol className="scoreboard">
        {game.players.map((p, i) => (
          <li key={p.id} className={i === game.current ? "current" : ""}>
            <span className="name">
              {p.name}
              {p.id === meId && " (you)"}
              {props.nameBadge?.(p.id)}
            </span>
            <span className="score">{fmt(p.score)}</span>
            {awayIds?.has(p.id) ? (
              <span className="tag away">away</span>
            ) : (
              !p.onBoard && <span className="tag">not on board</span>
            )}
          </li>
        ))}
      </ol>

      <section className="table" aria-live="polite">
        <div className="turn-head">
          <span className="whose">{isMe ? "Your turn" : player.name}</span>
          {game.phase !== "deciding" && (
            <span className={turn?.phase === "crapped-out" ? "points lost" : "points"}>
              {turn?.phase === "crapped-out" ? 0 : fmt(pendingPoints)}
            </span>
          )}
        </div>

        {game.phase === "deciding" && live && (
          <div className="decide">
            <p>
              {liveFromName} banked <strong>{fmt(live.turnPoints)}</strong> with {live.diceToRoll} live{" "}
              {live.diceToRoll === 1 ? "die" : "dice"}.
            </p>
            {myTurn ? (
              <div className="actions inline">
                <button type="button" className="secondary" onClick={() => props.onChoose("fresh")}>
                  Start fresh (5 dice)
                </button>
                <button type="button" className="primary" onClick={() => props.onChoose("continue")}>
                  Carry on from {fmt(live.turnPoints)} ({dice(live.diceToRoll)})
                </button>
              </div>
            ) : (
              <p className="muted">{player.name} is deciding whether to carry on or start fresh…</p>
            )}
          </div>
        )}

        {game.phase !== "deciding" && turn && (
          <>
            {/* Fills the space above, so the dice sit at the bottom near your thumbs. */}
            <div className="kept">
              {(turn.kept.length > 0 || turn.inheritedPoints > 0) && (
                <>
                  <span className="eyebrow">Set aside</span>
                  {turn.inheritedPoints > 0 && (
                    <div className="kept-group">
                      <span className="muted">From {liveFromName ?? "previous player"}</span>
                      <span className="kept-points">{fmt(turn.inheritedPoints)}</span>
                    </div>
                  )}
                  {turn.kept.map((group, g) => (
                    <div className="kept-group" key={g}>
                      <span className="kept-dice">
                        {group.faces.map((f, i) => (
                          <Die key={i} face={f} size="sm" />
                        ))}
                      </span>
                      <span className="kept-points">+{fmt(group.points)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>

            {turn.phase === "banked" ? (
              <div className="dice-row placeholder">
                {`${dice(turn.diceToRoll)} worth ${fmt(turn.turnPoints)} ${turn.diceToRoll === 1 ? "passes" : "pass"} to ${nameOf(nextPlayer.id)}`}
              </div>
            ) : turn.roll ? (
              <div className={turn.phase === "crapped-out" ? "dice-row bust" : "dice-row"} key={rollId}>
                {turn.roll.map((face, i) => (
                  <Die
                    key={i}
                    face={face}
                    rolling
                    selected={selected.includes(i)}
                    hinted={hintIndices?.includes(i) ?? false}
                    {...(choosing && myTurn ? { onClick: () => props.onToggle(i) } : {})}
                  />
                ))}
              </div>
            ) : (
              <div className="dice-row placeholder">
                {myTurn ? "Roll" : `${player.name} rolls`} {dice(turn.diceToRoll)}
                {turn.inheritedPoints > 0 && ` to build on ${fmt(turn.inheritedPoints)}`}
              </div>
            )}

            <div className="status">
              {game.deadDice === "no-room" && turn.roll === null && (
                <p className="muted">The live dice would put {myTurn ? "you" : player.name} over {fmt(target)}, so it's a fresh start.</p>
              )}
              {!player.onBoard && game.phase === "playing" && turn.roll === null && (
                <p className="muted">
                  Not on the board yet.
                  <br />
                  {who} {needs} {openingMin} this turn to bank.
                </p>
              )}
              {player.onBoard && target - player.score <= 1000 && game.phase === "playing" && (
                <p className="muted">
                  {myTurn ? "Needs" : `${player.name} needs`} exactly {fmt(target - player.score - turn.turnPoints)} more to win.
                </p>
              )}
              {turn.phase === "crapped-out" && turn.crapOutReason === "no-score" && (
                <p className="bad">Crapped out! Nothing scored, so this turn is worth 0.</p>
              )}
              {turn.phase === "crapped-out" && turn.crapOutReason === "over-target" && (
                <p className="bad">Crapped out! Every scoring choice would go over {fmt(target)}.</p>
              )}
              {turnOver && lastRecord?.outcome === "banked" && <p className="good">Banked {fmt(lastRecord.points)}.</p>}
              {turn.phase === "ready" && turn.kept.length > 0 && turn.diceToRoll === DICE_PER_TURN && (
                <p className="good">Hot dice! Every die scored. Pick up all five and keep going.</p>
              )}
              {choosing && selected.length === 0 && (
                <p>{myTurn ? "Tap the dice you want to set aside." : `${player.name} is choosing dice…`}</p>
              )}
              {choosing && selected.length > 0 && !selection && <p className="bad">Every die set aside has to score.</p>}
              {choosing && overTarget && <p className="bad">That would go over {fmt(target)}.</p>}
              {choosing && validSelection && <p className="selection-points">+{fmt(selection.points)}</p>}
              {choosing && validSelection && selected.length === turn.diceToRoll && (
                <p className="good">Every die scores: rolling on picks all five back up.</p>
              )}
              {error && <p className="bad">{error}</p>}
            </div>
          </>
        )}
      </section>

      <div className="actions">
        {game.phase === "playing" && myTurn && (
          <>
            <button type="button" className="secondary" onClick={props.onBank} disabled={bankReason !== null}>
              <span>Bank{bankReason === null ? ` ${fmt(pendingPoints)}` : ""}</span>
              {bankReason === null && <span className="sub">End turn</span>}
            </button>
            <button type="button" className="primary" onClick={props.onRoll} disabled={!canRoll}>
              {choosing ? (
                <>
                  <span>Keep + Roll</span>
                  <span className="sub">
                    {!validSelection
                      ? "Tap scoring dice first"
                      : selected.length === turn.diceToRoll
                        ? "All 5 dice again"
                        : dice(diceAfterKeep)}
                  </span>
                </>
              ) : (
                <span>Roll {dice(turn?.diceToRoll ?? DICE_PER_TURN)}</span>
              )}
            </button>
          </>
        )}
        {(game.phase === "playing" || game.phase === "deciding") && !myTurn && (
          <div className="waiting">
            <span>{awayIds?.has(player.id) ? `Waiting for ${player.name} to come back…` : `${player.name}'s turn`}</span>
          </div>
        )}
        {turnOver && (
          <button
            type="button"
            key={game.turnNumber}
            className="primary countdown"
            style={{ "--pause": `${Math.max(0, (pauseEndsAt ?? Date.now()) - Date.now())}ms` } as CSSProperties}
            onClick={props.onNext}
            disabled={!canSkipPause}
          >
            <span>
              {game.players.length === 1 ? "Next turn" : nextPlayer.id === meId ? "You're up next" : `Pass to ${nextPlayer.name}`}
            </span>
            <span className="sub">
              Going automatically in {secondsLeft}s{canSkipPause ? " · tap to go now" : ""}
            </span>
          </button>
        )}
      </div>
      {/* Always rendered so the buttons don't jump when a hint appears. */}
      <p className="hint-line muted">
        {myTurn && bankReason && bankReason !== "not-playing" && turn?.phase === "choosing" && validSelection ? bankReason : " "}
      </p>
    </main>
  );
}

function useSecondsLeft(endsAt: number | null): number {
  const compute = () => (endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const [seconds, setSeconds] = useState(compute);
  useEffect(() => {
    setSeconds(compute());
    if (endsAt === null) return;
    const tick = setInterval(() => setSeconds(compute()), 200);
    return () => clearInterval(tick);
  }, [endsAt]);
  return seconds;
}

/** Bottom sheet for the ☰ menu. */
export function MenuSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function RulesPanel({ game }: { game: GameState }) {
  const { target, openingMin } = game.config;
  return (
    <details className="panel">
      <summary>Rules</summary>
      <ul className="rules">
        <li>Each 1: 100 · Each 5: 50</li>
        <li>Three of a kind: 1s = 1,000, others face × 100</li>
        <li>Four of a kind: double three of a kind · Five: double four</li>
        <li>4 in a row: 250 · 5 in a row: 500</li>
        <li>Full house: three-of-a-kind value of both numbers (a pair of 1s counts 200)</li>
        <li>Combos only count within a single roll</li>
        <li>All five dice scored? Pick them all up and keep rolling</li>
        <li>Need {openingMin} in one turn to get on the board</li>
        <li>After a bank, the next player may carry on from those points with the dice left, or start fresh</li>
        <li>Win by hitting exactly {fmt(target)}</li>
      </ul>
    </details>
  );
}

export function HistoryPanel({ game }: { game: GameState }) {
  if (game.history.length === 0) return null;
  return (
    <details className="panel" open>
      <summary>History</summary>
      <ol className="history">
        {[...game.history].reverse().map((h) => (
          <li key={h.turnNumber}>
            <span>
              {game.players.find((p) => p.id === h.playerId)?.name} · T{h.turnNumber}
            </span>
            <span className={h.outcome === "banked" ? "good" : "bad"}>
              {h.outcome === "banked" ? `+${fmt(h.points)}` : h.outcome === "skipped" ? "Skipped" : "Crapped out"}
            </span>
            <span className="muted">{h.inherited > 0 ? `carried ${fmt(h.inherited)}` : ""}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Sound effects on/off and volume, for the ☰ menu. */
export function SoundSettings() {
  const muted = useMuted();
  const volume = useSoundVolume();
  return (
    <div className="panel settings">
      <label className="setting-row">
        <span>Sound effects</span>
        <input type="checkbox" className="switch" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} />
      </label>
      {!muted && (
        <label className="setting-row">
          <span className="muted">Volume</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={previewVolume}
            onKeyUp={previewVolume}
          />
        </label>
      )}
    </div>
  );
}
