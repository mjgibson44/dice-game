/**
 * Practice mode: pass-and-play on one device, with testing tools.
 * Runs the rules engine right here in the browser; no server involved.
 */

import {
  bankTurn,
  bestSelection,
  chooseStart,
  createGame,
  keep,
  nextTurn,
  roll,
  rollDice,
  TURN_OVER_PAUSE_MS,
  type Face,
  type GameResult,
  type GameState,
} from "@dice-game/shared";
import { useEffect, useState } from "react";
import { GameOver } from "./GameOver.tsx";
import { fmt, GameView, HistoryPanel, MenuSheet, RulesPanel, SoundToggle } from "./GameView.tsx";

function parseDigits(text: string): Face[] | null {
  const digits = text.match(/[1-6]/g);
  return digits ? (digits.map(Number) as Face[]) : null;
}

export function PracticeGame({ onHome }: { onHome: () => void }) {
  const [game, setGame] = useState<GameState | null>(null);
  if (!game) return <SetupScreen onStart={setGame} onHome={onHome} />;
  if (game.phase === "finished") {
    return (
      <GameOver
        game={game}
        meId={null}
        onPlayAgain={() => setGame(createGame(game.players.map(({ id, name }) => ({ id, name })), game.config))}
        onGoHome={onHome}
      />
    );
  }
  return <PracticeTable game={game} setGame={setGame} onQuit={() => setGame(null)} />;
}

function SetupScreen({ onStart, onHome }: { onStart: (g: GameState) => void; onHome: () => void }) {
  const [count, setCount] = useState(1);
  const [names, setNames] = useState(["You", "Player 2", "Player 3", "Player 4", "Player 5"]);

  function start() {
    onStart(createGame(names.slice(0, count).map((name, i) => ({ id: `p${i}`, name: name.trim() || `Player ${i + 1}` }))));
  }

  return (
    <main className="app setup">
      <header className="topbar">
        <button type="button" className="link" onClick={onHome}>
          ← Home
        </button>
      </header>
      <h1>Practice</h1>
      <p className="muted">Everyone plays on this device. Pass the phone between turns.</p>
      <div className="panel open">
        <div className="field">
          <span>Players</span>
          <div className="stepper">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={n === count ? "chip active" : "chip"} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {names.slice(0, count).map((name, i) => (
          <label className="field" key={i}>
            <span>Player {i + 1}</span>
            <input value={name} onChange={(e) => setNames((ns) => ns.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={start}>
          Start
        </button>
      </div>
    </main>
  );
}

interface PracticeTableProps {
  game: GameState;
  setGame: (g: GameState) => void;
  onQuit: () => void;
}

function PracticeTable({ game, setGame, onQuit }: PracticeTableProps) {
  const [selected, setSelected] = useState<number[]>([]);
  const [rollId, setRollId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rigText, setRigText] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [scoreText, setScoreText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pauseEndsAt, setPauseEndsAt] = useState<number | null>(null);

  const turn = game.turn;
  const player = game.players[game.current]!;
  const { target, openingMin } = game.config;
  const choosing = game.phase === "playing" && turn?.phase === "choosing";
  const hint = showHint && choosing && turn.roll ? bestSelection(turn.roll) : null;
  const diceAfterKeep = turn ? turn.diceToRoll - selected.length || 5 : 5;

  function apply(result: GameResult): GameState | null {
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    return result.state;
  }

  function nextFaces(count: number): Face[] | null {
    const rig = parseDigits(rigText);
    if (!rig) return rollDice(count);
    if (rig.length !== count) {
      setError(`Rigged roll needs exactly ${count} dice (you entered ${rig.length}).`);
      return null;
    }
    setRigText("");
    return rig;
  }

  function onRoll() {
    setError(null);
    let g: GameState | null = game;
    if (g.turn?.phase === "choosing") g = apply(keep(g, selected));
    if (!g?.turn) return;
    const faces = nextFaces(g.turn.diceToRoll);
    if (!faces) return;
    g = apply(roll(g, faces));
    if (!g) return;
    setGame(g);
    setSelected([]);
    setRollId((n) => n + 1);
  }

  function onBank() {
    setError(null);
    let g: GameState | null = game;
    if (g.turn?.phase === "choosing") g = apply(keep(g, selected));
    if (!g) return;
    g = apply(bankTurn(g));
    if (!g) return;
    setGame(g);
    setSelected([]);
  }

  function onNext() {
    const g = apply(nextTurn(game));
    if (g) {
      setGame(g);
      setSelected([]);
      setError(null);
    }
  }

  function onChoose(choice: "fresh" | "continue") {
    const g = apply(chooseStart(game, choice));
    if (g) setGame(g);
  }

  // When a turn ends, show how it ended for a moment, then pass play on automatically.
  useEffect(() => {
    if (game.phase !== "turn-over") {
      setPauseEndsAt(null);
      return;
    }
    setPauseEndsAt(Date.now() + TURN_OVER_PAUSE_MS);
    const timer = setTimeout(onNext, TURN_OVER_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [game]);

  /** Testing tool: set the current player's score (puts them on the board). */
  function onSetScore() {
    const score = Number(scoreText.replace(/[^0-9]/g, ""));
    if (!Number.isFinite(score) || score < 0 || score >= target) {
      setError(`Score must be between 0 and ${fmt(target - 1)}.`);
      return;
    }
    const players = game.players.map((p, i) => (i === game.current ? { ...p, score, onBoard: score > 0 || p.onBoard } : p));
    const limits = { maxTurnPoints: target - score, minBank: players[game.current]!.onBoard ? 0 : openingMin };
    setGame({ ...game, players, turn: game.turn ? { ...game.turn, limits } : null });
    setScoreText("");
    setError(null);
  }

  const rigCount = game.phase === "deciding" ? null : turn?.phase === "choosing" ? diceAfterKeep : (turn?.diceToRoll ?? null);
  const rigPlaceholder = rigCount === null ? "Faces 1-6" : `${rigCount} ${rigCount === 1 ? "number" : "numbers"}, 1-6`;

  return (
    <>
      <GameView
        game={game}
        selected={selected}
        myTurn
        meId={null}
        rollId={rollId}
        pauseEndsAt={pauseEndsAt}
        canSkipPause
        error={error}
        hintIndices={hint?.indices ?? null}
        label={`Practice · Turn ${game.turnNumber}`}
        onToggle={(i) => {
          setError(null);
          setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
        }}
        onRoll={onRoll}
        onBank={onBank}
        onChoose={onChoose}
        onNext={onNext}
        onOpenMenu={() => setMenuOpen(true)}
      />
      {menuOpen && (
        <MenuSheet onClose={() => setMenuOpen(false)}>
          <div className="sheet-head">
            <button type="button" className="link" onClick={onQuit}>
              New game
            </button>
            <button type="button" className="chip" onClick={() => setMenuOpen(false)}>
              Close
            </button>
          </div>
          <SoundToggle />
          <details className="panel">
            <summary>Testing tools</summary>
            <label className="field">
              <span>Rig the next roll (e.g. 1 1 1 5 5)</span>
              <input inputMode="numeric" value={rigText} onChange={(e) => setRigText(e.target.value)} placeholder={rigPlaceholder} />
            </label>
            <div className="field">
              <span>Set score for {player.name}</span>
              <div className="row">
                <input inputMode="numeric" value={scoreText} onChange={(e) => setScoreText(e.target.value)} placeholder="e.g. 9800" />
                <button type="button" className="chip" onClick={onSetScore}>
                  Set
                </button>
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={showHint} onChange={(e) => setShowHint(e.target.checked)} />
              <span>Highlight the best dice to keep{hint ? ` (${fmt(hint.points)})` : ""}</span>
            </label>
          </details>
          <RulesPanel game={game} />
          <HistoryPanel game={game} />
        </MenuSheet>
      )}
    </>
  );
}
