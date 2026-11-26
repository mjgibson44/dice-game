/**
 * /sounds: try each roll sound with the dice landing in time, and pick the
 * one this device uses.
 */

import type { Face } from "@dice-game/shared";
import { useState, type CSSProperties } from "react";
import { Die } from "./Die.tsx";
import { previewRoll, ROLL_SOUNDS, setRollSound, useRollSound } from "./sound.ts";

const GROUPS = [...new Set(ROLL_SOUNDS.map((sound) => sound.group))];

const randomFaces = (n: number) => Array.from({ length: n }, () => (1 + Math.floor(Math.random() * 6)) as Face);

export function SoundSampler({ onHome }: { onHome: () => void }) {
  const chosen = useRollSound();
  const [dice, setDice] = useState(5);
  // The card that last played, with a counter so the dice animation replays every time.
  const [playing, setPlaying] = useState<{ id: string; n: number; faces: Face[] } | null>(null);

  const play = (id: string) => {
    previewRoll(id, dice);
    setPlaying((p) => ({ id, n: (p?.n ?? 0) + 1, faces: randomFaces(dice) }));
  };

  return (
    <main className="app sampler">
      <header className="topbar">
        <button type="button" className="link" onClick={onHome}>
          ← Home
        </button>
        <span className="eyebrow">Roll sounds</span>
      </header>

      <div className="setting-row">
        <span className="muted">Dice in the roll</span>
        <span className="stepper">
          {[1, 3, 5].map((n) => (
            <button key={n} type="button" className={n === dice ? "chip active" : "chip"} onClick={() => setDice(n)}>
              {n}
            </button>
          ))}
        </span>
      </div>

      {GROUPS.map((group) => (
        <section key={group} className="sound-group">
          <h2 className="eyebrow">{group}</h2>
          <ul className="sound-list">
            {ROLL_SOUNDS.filter((sound) => sound.group === group).map((sound) => (
              <li key={sound.id} className={sound.id === chosen ? "chosen" : ""}>
                <div className="sound-head">
                  <div>
                    <strong>{sound.name}</strong>
                    <p className="muted small">{sound.description}</p>
                  </div>
                  <button type="button" className="big-button primary" onClick={() => play(sound.id)}>
                    ▶ Play
                  </button>
                </div>
                <div className="sample-dice" style={{ "--shake": `${sound.leadMs}ms` } as CSSProperties}>
                  {playing?.id === sound.id && (
                    <div className="dice-row" key={playing.n}>
                      {playing.faces.map((face, i) => (
                        <Die key={i} face={face} rolling />
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className={sound.id === chosen ? "use chosen" : "use"} onClick={() => setRollSound(sound.id)}>
                  {sound.id === chosen ? "✓ Using this one" : "Use this one"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted small center">Your pick is saved on this device, so you can hear it in a real game.</p>
    </main>
  );
}
