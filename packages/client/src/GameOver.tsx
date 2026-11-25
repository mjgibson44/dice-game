import type { GameState, Player } from "@dice-game/shared";
import type { ReactNode } from "react";

const fmt = (n: number) => n.toLocaleString("en-US");

interface Standing {
  player: Player;
  rank: number;
  banks: number;
  crapOuts: number;
  bestTurn: number;
}

function standings(game: GameState): Standing[] {
  const sorted = [...game.players].sort((a, b) => {
    if (a.id === game.winnerId) return -1;
    if (b.id === game.winnerId) return 1;
    return b.score - a.score;
  });
  let rank = 0;
  let lastScore: number | null = null;
  return sorted.map((player, i) => {
    // Players tied on score share a rank; the winner is always first.
    if (i === 0 || player.score !== lastScore) rank = i + 1;
    lastScore = player.score;
    const turns = game.history.filter((h) => h.playerId === player.id);
    const banked = turns.filter((h) => h.outcome === "banked");
    return {
      player,
      rank,
      banks: banked.length,
      crapOuts: turns.filter((h) => h.outcome === "crapped-out").length,
      bestTurn: Math.max(0, ...banked.map((h) => h.points)),
    };
  });
}

interface GameOverProps {
  game: GameState;
  /** The viewer's player id online, so the headline can say "You win!". Null in practice mode. */
  meId: string | null;
  /** Null hides the button (online, only the host can start a rematch). */
  onPlayAgain: (() => void) | null;
  onGoHome: () => void;
  /** Shown instead of Play again for online players who aren't the host. */
  waitingNote?: string;
  /** Anything extra under the buttons (host's "back to lobby" online). */
  footer?: ReactNode;
}

export function GameOver({ game, meId, onPlayAgain, onGoHome, waitingNote, footer }: GameOverProps) {
  const winner = game.players.find((p) => p.id === game.winnerId);
  const finalTurn = game.history.at(-1);
  const rows = standings(game);
  const ended = game.endReason === "ended";

  return (
    <main className="app game-over">
      <section className="winner">
        <div className="trophy" aria-hidden>
          {ended ? "🏁" : "🏆"}
        </div>
        <h1>
          {ended
            ? "Game ended"
            : winner && (winner.id === meId || (meId === null && winner.name === "You"))
              ? "You win!"
              : `${winner?.name ?? "Someone"} wins!`}
        </h1>
        <p className="muted">
          {ended
            ? "The host stopped the game. Final scores:"
            : game.endReason === "last-player"
              ? "Everyone else left the game"
              : `Hit exactly ${fmt(game.config.target)}`}
        </p>
        <div className="game-facts">
          <span>
            <strong>{game.turnNumber}</strong> {game.turnNumber === 1 ? "turn" : "turns"}
          </span>
          {finalTurn && !ended && (
            <span>
              Final bank <strong>{fmt(finalTurn.points)}</strong>
            </span>
          )}
        </div>
      </section>

      <ol className="standings">
        {rows.map(({ player, rank, banks, crapOuts, bestTurn }) => (
          <li key={player.id} className={player.id === game.winnerId ? "winner-row" : ""}>
            <span className="rank">{rank}</span>
            <span className="name">{player.name}</span>
            <span className="final-score">{fmt(player.score)}</span>
            <dl className="stats">
              <div>
                <dt>Best turn</dt>
                <dd>{fmt(bestTurn)}</dd>
              </div>
              <div>
                <dt>Banks</dt>
                <dd>{banks}</dd>
              </div>
              <div>
                <dt>Crap-outs</dt>
                <dd>{crapOuts}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>

      <div className="actions end">
        <button type="button" className="secondary" onClick={onGoHome}>
          Go home
        </button>
        {onPlayAgain ? (
          <button type="button" className="primary" onClick={onPlayAgain}>
            Play again
          </button>
        ) : (
          <div className="waiting">{waitingNote ?? ""}</div>
        )}
      </div>
      {footer}
    </main>
  );
}
