import { CODE_LENGTH, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, normalizeCode } from "@dice-game/shared";
import { useEffect, useRef, useState } from "react";
import { connection, loadSession, useConnection } from "./online/connection.ts";

const NAME_KEY = "dice-game:name";

export function useSavedName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  return [
    name,
    (value: string) => {
      setName(value);
      localStorage.setItem(NAME_KEY, value);
    },
  ];
}

export function Home({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [name, setName] = useSavedName();
  const [players, setPlayers] = useState(4);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"create" | "join" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const { room, error } = useConnection();
  const session = loadSession();
  const startedFrom = useRef<string | null>(null);

  // Once the server confirms we're in a room, go to it.
  useEffect(() => {
    if (pending && room && room.code !== startedFrom.current) onNavigate(`/room/${room.code}`);
  }, [pending, room]);

  useEffect(() => {
    if (pending && error) setPending(null);
  }, [error]);

  function needName(): boolean {
    if (name.trim()) return false;
    setLocalError("Enter your name first.");
    return true;
  }

  function create() {
    if (needName()) return;
    setLocalError(null);
    connection.clearError();
    startedFrom.current = room?.code ?? null;
    setPending("create");
    connection.send({ type: "create", name, maxPlayers: players });
  }

  function join() {
    if (needName()) return;
    const clean = normalizeCode(code);
    if (clean.length !== CODE_LENGTH) {
      setLocalError(`Game codes are ${CODE_LENGTH} characters.`);
      return;
    }
    setLocalError(null);
    connection.clearError();
    startedFrom.current = room?.code ?? null;
    setPending("join");
    connection.send({ type: "join", code: clean, name });
  }

  const shownError = localError ?? (pending === null ? error : null);

  return (
    <main className="app home">
      <section className="hero">
        <div className="hero-dice" role="img" aria-label="Dice Game">
          🎲
        </div>
      </section>

      {session && (
        <button type="button" className="rejoin" onClick={() => onNavigate(`/room/${session.code}`)}>
          Back to game <strong>{session.code}</strong> →
        </button>
      )}

      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="nickname"
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sam"
        />
      </label>

      <div className="panel open card">
        <h2>Host a game</h2>
        <div className="field">
          <span>How many players?</span>
          <div className="stepper">
            {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => i + MIN_PLAYERS).map((n) => (
              <button key={n} type="button" className={n === players ? "chip active" : "chip"} onClick={() => setPlayers(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="primary big-button" onClick={create} disabled={pending !== null}>
          {pending === "create" ? "Creating…" : "Create game"}
        </button>
      </div>

      <div className="panel open card">
        <h2>Join a game</h2>
        <div className="row">
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && join()}
            placeholder="CODE"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Game code"
          />
          <button type="button" className="secondary big-button" onClick={join} disabled={pending !== null}>
            {pending === "join" ? "Joining…" : "Join"}
          </button>
        </div>
      </div>

      {shownError && <p className="bad center">{shownError}</p>}

      <button type="button" className="link center" onClick={() => onNavigate("/practice")}>
        Practice on this device →
      </button>
    </main>
  );
}
