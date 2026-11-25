/**
 * Game sounds, synthesized with the Web Audio API (no audio files).
 * Phones only allow audio after the first tap, so the context is unlocked on
 * the first pointer/key press anywhere in the app.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { GameState } from "@dice-game/shared";

const MUTE_KEY = "dice-game:muted";

let ctx: AudioContext | null = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";
const listeners = new Set<() => void>();

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// Unlock audio on the first interaction (required on iOS and most mobile browsers).
for (const type of ["pointerdown", "keydown"] as const) {
  addEventListener(type, () => audio(), { once: true, capture: true });
}

export function setMuted(value: boolean) {
  muted = value;
  localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  for (const l of listeners) l();
}

export function useMuted(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => muted,
  );
}

/** One short tone with a quick attack and exponential fade. */
function tone(ac: AudioContext, freq: number, start: number, duration: number, volume = 0.2, type: OscillatorType = "sine") {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** A short burst of filtered noise: one die clacking. */
function clack(ac: AudioContext, start: number, volume: number, pitch: number) {
  const length = Math.floor(ac.sampleRate * 0.045);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = pitch;
  filter.Q.value = 1.2;
  const gain = ac.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(start);
}

export const sounds = {
  /** Dice rattling across the table. */
  roll(dice = 5) {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    const hits = 6 + dice * 2;
    for (let i = 0; i < hits; i++) {
      // Clacks bunch up early and thin out as the dice settle.
      const at = t + 0.42 * (i / hits) ** 1.6 + Math.random() * 0.02;
      clack(ac, at, 0.5 * (1 - (i / hits) * 0.6), 1800 + Math.random() * 2200);
    }
  },
  /** Banking: a bright two-note "ka-ching". */
  bank() {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    tone(ac, 1318.5, t, 0.18, 0.18, "triangle");
    tone(ac, 1975.5, t + 0.08, 0.45, 0.16, "triangle");
  },
  /** Crapping out: a soft falling "bonk". */
  bust() {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.35);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  },
  /** Play passing to the next player: a light tick. */
  turnChange() {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    tone(ac, 660, t, 0.12, 0.1);
    tone(ac, 880, t + 0.07, 0.16, 0.08);
  },
  /** It's your turn: a rising three-note chime. */
  yourTurn() {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    tone(ac, 523.25, t, 0.25, 0.18);
    tone(ac, 659.25, t + 0.11, 0.25, 0.18);
    tone(ac, 1046.5, t + 0.22, 0.5, 0.2);
  },
};

/**
 * Play sounds as the game changes: rolls, banks, crap-outs, and turns passing.
 * `meId` is the viewer online (so "your turn" gets its own chime); null in pass-and-play.
 */
export function useGameSounds(game: GameState, rollId: number, meId: string | null) {
  const prev = useRef({ rollId, turnNumber: game.turnNumber, history: game.history.length, ready: false });

  useEffect(() => {
    const before = prev.current;
    prev.current = { rollId, turnNumber: game.turnNumber, history: game.history.length, ready: true };
    // Don't replay anything for the state we arrived in.
    if (!before.ready) return;

    if (rollId !== before.rollId) {
      if (game.turn?.phase === "crapped-out") {
        sounds.roll(game.turn.roll?.length);
        setTimeout(() => sounds.bust(), 450);
      } else {
        sounds.roll(game.turn?.roll?.length);
      }
    }
    if (game.history.length > before.history && game.history.at(-1)?.outcome === "banked") sounds.bank();
    if (game.turnNumber !== before.turnNumber && game.phase !== "finished") {
      const current = game.players[game.current];
      if (meId !== null && current?.id === meId) sounds.yourTurn();
      else sounds.turnChange();
    }
  }, [game, rollId, meId]);
}
