/**
 * Everything at /room/CODE: joining, the lobby, the live game, and the end
 * screen. All moves go to the server; this only shows what it sends back.
 */

import { currentPlayer, MAX_NAME_LENGTH, MIN_PLAYERS, type RoomView } from "@dice-game/shared";
import { useEffect, useRef, useState } from "react";
import { GameOver } from "../GameOver.tsx";
import { GameView, HistoryPanel, MenuSheet, RulesPanel, SoundToggle } from "../GameView.tsx";
import { AUTO_JOIN_KEY, useSavedName } from "../Home.tsx";
import { connection, loadSession, useConnection } from "./connection.ts";

interface OnlineRoomProps {
  code: string;
  onHome: () => void;
}

export function OnlineRoom({ code, onHome }: OnlineRoomProps) {
  const state = useConnection();
  // Arrived from Create or Join on the home screen: take a seat straight away without asking for a name.
  const [autoJoinName] = useState(() => {
    try {
      const pending = JSON.parse(sessionStorage.getItem(AUTO_JOIN_KEY) ?? "null") as { code: string; name: string } | null;
      return pending?.code === code && pending.name && !loadSession(code) ? pending.name : null;
    } catch {
      return null;
    }
  });
  const autoJoin = autoJoinName !== null;

  useEffect(() => {
    connection.open(code);
    if (autoJoinName) connection.send({ type: "join", name: autoJoinName });
    sessionStorage.removeItem(AUTO_JOIN_KEY);
    return () => connection.close();
  }, [code]);

  function leave() {
    connection.leave();
    onHome();
  }

  const room = state.room?.code === code ? state.room : null;
  const seated = room && state.me && room.members.some((m) => m.id === state.me);

  if (state.fatal) {
    return (
      <Notice title="Game not available" onHome={onHome}>
        {state.error ?? "That game has ended."}
      </Notice>
    );
  }
  if (!room || !seated) {
    const waiting = (state.me !== null || autoJoin) && !state.error;
    if (!waiting) return <JoinForm code={code} onHome={onHome} error={state.error} />;
    return (
      <Notice title={state.me ? "Connecting…" : "Joining…"} onHome={onHome}>
        Game {code}
      </Notice>
    );
  }

  const me = state.me!;
  return (
    <>
      {state.status === "reconnecting" && <div className="banner">Reconnecting…</div>}
      {room.status === "lobby" && <Lobby room={room} me={me} onLeave={leave} error={state.error} />}
      {room.status === "playing" && (
        <OnlineGame room={room} me={me} receivedAt={state.roomReceivedAt} error={state.error} onLeave={leave} />
      )}
      {room.status === "finished" && room.game && (
        <GameOver
          game={room.game}
          meId={me}
          onPlayAgain={room.hostId === me ? () => connection.send({ type: "playAgain" }) : null}
          waitingNote={`Waiting for ${room.members.find((m) => m.id === room.hostId)?.name ?? "the host"} to start a rematch…`}
          onGoHome={leave}
        />
      )}
    </>
  );
}

function Notice({ title, children, onHome }: { title: string; children: React.ReactNode; onHome: () => void }) {
  return (
    <main className="app notice">
      <h1>{title}</h1>
      <p className="muted">{children}</p>
      <div className="actions">
        <button type="button" className="secondary" onClick={onHome}>
          Go home
        </button>
      </div>
    </main>
  );
}

function JoinForm({ code, onHome, error }: { code: string; onHome: () => void; error: string | null }) {
  const [name, setName] = useSavedName();
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (error) setSent(false);
  }, [error]);

  function join() {
    if (!name.trim()) return;
    connection.clearError();
    setSent(true);
    connection.send({ type: "join", name });
  }

  return (
    <main className="app notice">
      <header className="topbar">
        <button type="button" className="link" onClick={onHome}>
          ← Home
        </button>
      </header>
      <p className="eyebrow">Joining game</p>
      <div className="code-display">{code}</div>
      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="nickname"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && join()}
          placeholder="e.g. Sam"
        />
      </label>
      {error && <p className="bad center">{error}</p>}
      <div className="actions">
        <button type="button" className="primary" onClick={join} disabled={!name.trim() || sent}>
          {sent ? "Joining…" : "Join game"}
        </button>
      </div>
    </main>
  );
}

function Lobby({ room, me, onLeave, error }: { room: RoomView; me: string; onLeave: () => void; error: string | null }) {
  const [copied, setCopied] = useState(false);
  const isHost = room.hostId === me;
  const host = room.members.find((m) => m.id === room.hostId);
  const link = `${location.origin}/room/${room.code}`;
  const openSeats = Math.max(0, room.maxPlayers - room.members.length);

  async function share() {
    const shareData = { title: "Dice Game", text: `Join my dice game! Code ${room.code}`, url: link };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // Cancelled or unsupported: fall back to copying.
      }
    }
    await navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="app lobby">
      <header className="topbar">
        <button type="button" className="link" onClick={onLeave}>
          ← Leave
        </button>
      </header>

      <section className="lobby-code">
        <p className="eyebrow">Game code</p>
        <div className="code-display">{room.code}</div>
        <button type="button" className="secondary share" onClick={share}>
          {copied ? "Link copied!" : "Share invite link"}
        </button>
      </section>

      <section className="panel open">
        <div className="members-head">
          <h2>Players</h2>
          <span className="muted">
            {room.members.length} of {room.maxPlayers}
          </span>
        </div>
        <ol className="members">
          {room.members.map((m) => (
            <li key={m.id}>
              <span className={m.connected ? "dot on" : "dot"} aria-label={m.connected ? "connected" : "away"} />
              <span className="name">
                {m.name}
                {m.id === me && <span className="muted"> (you)</span>}
              </span>
              {m.id === room.hostId && <span className="tag host">host</span>}
            </li>
          ))}
          {Array.from({ length: openSeats }, (_, i) => (
            <li key={`open${i}`} className="open-seat">
              <span className="dot" />
              <span className="muted">Waiting for a player…</span>
            </li>
          ))}
        </ol>
      </section>

      {error && <p className="bad center">{error}</p>}

      <div className="actions">
        {isHost ? (
          <button
            type="button"
            className="primary"
            disabled={room.members.length < MIN_PLAYERS}
            onClick={() => connection.send({ type: "start" })}
          >
            <span>Start game</span>
            <span className="sub">
              {room.members.length < MIN_PLAYERS
                ? `Need at least ${MIN_PLAYERS} players`
                : openSeats > 0
                  ? `${openSeats} open ${openSeats === 1 ? "seat" : "seats"} will be dropped`
                  : "Everyone's here"}
            </span>
          </button>
        ) : (
          <div className="waiting">Waiting for {host?.name ?? "the host"} to start…</div>
        )}
      </div>
    </main>
  );
}

interface OnlineGameProps {
  room: RoomView;
  me: string;
  receivedAt: number;
  error: string | null;
  onLeave: () => void;
}

function OnlineGame({ room, me, receivedAt, error, onLeave }: OnlineGameProps) {
  const game = room.game!;
  // Tagged with the roll it belongs to, so a new roll clears it straight away.
  const [picked, setPicked] = useState<{ roll: number; indices: number[] }>({ roll: -1, indices: [] });
  // Mirrors `picked` synchronously, so quick taps between renders build on each other.
  const pickedRef = useRef(picked);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const current = currentPlayer(game);
  const myTurn = current.id === me && (game.phase === "playing" || game.phase === "deciding");
  const upNext = game.players[(game.current + 1) % game.players.length]!;

  const mySelection = picked.roll === room.rollCount && myTurn ? picked.indices : [];

  const selected = myTurn ? mySelection : room.selection;
  const keepNow = game.turn?.phase === "choosing" ? mySelection : [];
  const pauseEndsAt = room.pauseRemainingMs === null ? null : receivedAt + room.pauseRemainingMs;
  const awayIds = new Set(room.members.filter((m) => !m.connected).map((m) => m.id));

  return (
    <>
      <GameView
        game={game}
        selected={selected}
        myTurn={myTurn}
        meId={me}
        rollId={room.rollCount}
        pauseEndsAt={pauseEndsAt}
        canSkipPause={current.id === me || upNext.id === me}
        awayIds={awayIds}
        error={error}
        label={`Game ${room.code} · Turn ${game.turnNumber}`}
        onToggle={(i) => {
          const prev = pickedRef.current.roll === room.rollCount ? pickedRef.current.indices : [];
          const next = prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i];
          pickedRef.current = { roll: room.rollCount, indices: next };
          setPicked(pickedRef.current);
          connection.send({ type: "select", indices: next });
        }}
        onRoll={() => connection.send({ type: "roll", keep: keepNow })}
        onBank={() => connection.send({ type: "bank", keep: keepNow })}
        onChoose={(choice) => connection.send({ type: "choose", choice })}
        onNext={() => connection.send({ type: "next" })}
        onOpenMenu={() => setMenuOpen(true)}
      />
      {menuOpen && (
        <MenuSheet
          onClose={() => {
            setMenuOpen(false);
            setConfirmLeave(false);
          }}
        >
          <div className="sheet-head">
            {confirmLeave ? (
              <button type="button" className="link bad" onClick={onLeave}>
                Really leave? Your seat stays empty.
              </button>
            ) : (
              <button type="button" className="link" onClick={() => setConfirmLeave(true)}>
                Leave game
              </button>
            )}
            <button type="button" className="chip" onClick={() => setMenuOpen(false)}>
              Close
            </button>
          </div>
          <SoundToggle />
          <div className="panel invite-line">
            Game code <strong>{room.code}</strong>
          </div>
          <RulesPanel game={game} />
          <HistoryPanel game={game} />
        </MenuSheet>
      )}
      {room.stuck && room.stuck.playerId !== me && <AwayPlayerModal room={room} me={me} />}
      {myTurn && <YourTurnToast key={game.turnNumber} />}
    </>
  );
}

/** "It's your turn" — shows when a turn comes to you, hides after 3 seconds or on a tap. */
function YourTurnToast() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    // Browsers only allow a buzz once the page has been tapped.
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(60);
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className="toast-backdrop" onClick={() => setVisible(false)}>
      <div className="toast" role="status">
        <span className="toast-dice" aria-hidden>
          🎲
        </span>
        It's your turn!
      </div>
    </div>
  );
}

/**
 * Shown to everyone else when the player whose turn it is has been away for a
 * minute: anyone can skip their turn, and everyone together can vote them out.
 */
function AwayPlayerModal({ room, me }: { room: RoomView; me: string }) {
  const stuck = room.stuck!;
  const name = room.members.find((m) => m.id === stuck.playerId)?.name ?? "This player";
  // "Keep waiting" tucks the dialog into a bar until the turn changes.
  const key = `${stuck.playerId}:${room.game?.turnNumber}`;
  const [minimizedFor, setMinimizedFor] = useState<string | null>(null);
  const iVoted = stuck.votes.includes(me);
  const others = stuck.voters.filter((id) => id !== me);
  const othersVoted = stuck.votes.filter((id) => id !== me).length;

  if (minimizedFor === key) {
    return (
      <button type="button" className="away-bar" onClick={() => setMinimizedFor(null)}>
        {name} is away · <strong>Options</strong>
      </button>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="away-title">
        <h2 id="away-title">{name} has been away for over a minute</h2>
        <p className="muted">It's their turn. You can skip it, or vote to remove them from the game.</p>
        <button type="button" className="primary modal-button" onClick={() => connection.send({ type: "skipTurn" })}>
          Skip {name}'s turn
        </button>
        <button
          type="button"
          className={iVoted ? "secondary modal-button voted" : "secondary modal-button"}
          onClick={() => connection.send({ type: "voteRemove", vote: !iVoted })}
        >
          <span>{iVoted ? "✓ You voted to remove them" : `Vote to remove ${name} from the game`}</span>
          <span className="sub">
            {stuck.votes.length} of {stuck.voters.length} {stuck.voters.length === 1 ? "vote" : "votes"}
            {others.length === 0
              ? " · your vote decides"
              : ` · needs everyone${iVoted && othersVoted < others.length ? `, waiting on ${others.length - othersVoted}` : ""}`}
          </span>
        </button>
        <button type="button" className="link" onClick={() => setMinimizedFor(key)}>
          Keep waiting
        </button>
      </div>
    </div>
  );
}
