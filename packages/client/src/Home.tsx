import { CODE_LENGTH, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, normalizeCode } from "@dice-game/shared";
import { useState } from "react";
import { createRoom, fetchRoomInfo, loadSession } from "./online/connection.ts";

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

/** Set just before going to a room, so the room page joins straight away instead of asking for a name. */
export const AUTO_JOIN_KEY = "dice-game:auto-join";

export function Home({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [name, setName] = useSavedName();
  const [players, setPlayers] = useState(4);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = loadSession();

  function needName(): boolean {
    if (name.trim()) return false;
    setError("Enter your name first.");
    return true;
  }

  function enter(roomCode: string) {
    sessionStorage.setItem(AUTO_JOIN_KEY, JSON.stringify({ code: roomCode, name: name.trim() }));
    onNavigate(`/room/${roomCode}`);
  }

  async function create() {
    if (needName()) return;
    setError(null);
    setPending("create");
    try {
      enter(await createRoom(players));
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
  }

  async function join() {
    if (needName()) return;
    const clean = normalizeCode(code);
    if (clean.length !== CODE_LENGTH) {
      setError(`Game codes are ${CODE_LENGTH} characters.`);
      return;
    }
    setError(null);
    setPending("join");
    try {
      const info = await fetchRoomInfo(clean);
      if (loadSession(clean)) return onNavigate(`/room/${clean}`);
      if (!info) setError("There's no game with that code.");
      else if (info.status !== "lobby") setError("That game has already started.");
      else if (info.players >= info.maxPlayers) setError("That game is full.");
      else return enter(clean);
    } catch (e) {
      setError((e as Error).message);
    }
    setPending(null);
  }

  const shownError = error;

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
