/**
 * Game sounds, synthesized with the Web Audio API (no audio files).
 * Phones only allow audio after the first tap, so the context is unlocked on
 * the first pointer/key press anywhere in the app.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { GameState } from "@dice-game/shared";

const MUTE_KEY = "dice-game:muted";
const VOLUME_KEY = "dice-game:sfx-volume";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";
let volume = Number(localStorage.getItem(VOLUME_KEY) ?? "0.8");
const listeners = new Set<() => void>();

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
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

export function setVolume(value: number) {
  volume = value;
  localStorage.setItem(VOLUME_KEY, String(value));
  if (master) master.gain.value = value;
  for (const l of listeners) l();
}

export function useSoundVolume(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => volume,
  );
}

/** A short click so people can hear the new volume while dragging the slider. */
export function previewVolume() {
  sounds.turnChange();
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
  osc.connect(gain).connect(master!);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** How long the cup shakes before the dice spill out. The dice animation waits this long too. */
export const SHAKE_MS = 380;

let noiseBuffer: AudioBuffer | null = null;

/** One second of white noise, made once and reused for every click. */
function noise(ac: AudioContext): AudioBuffer {
  if (noiseBuffer?.sampleRate === ac.sampleRate) return noiseBuffer;
  noiseBuffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

/** A tiny click of noise: a die knocking into something. */
function tick(ac: AudioContext, out: AudioNode, start: number, volume: number, pitch: number, length = 0.012, q = 2) {
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = pitch;
  filter.Q.value = q;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  src.connect(filter).connect(gain).connect(out);
  src.start(start, Math.random() * 0.9, length + 0.01);
}

/** A soft low knock: a die landing on the table. */
function thud(ac: AudioContext, start: number, volume: number, freq: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, start + 0.05);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);
  osc.connect(gain).connect(master!);
  osc.start(start);
  osc.stop(start + 0.08);
}

/** Dice rattling inside a cup: muffled, hollow clicks in three quick shakes. */
function cupShake(ac: AudioContext, t: number, dice: number) {
  // The cup: cuts the bright edge off the clicks and adds a hollow ring.
  const body = ac.createBiquadFilter();
  body.type = "peaking";
  body.frequency.value = 820;
  body.Q.value = 3;
  body.gain.value = 10;
  const muffle = ac.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 2400;
  body.connect(muffle).connect(master!);

  const shakes = 3;
  const gap = SHAKE_MS / 1000 / shakes;
  for (let s = 0; s < shakes; s++) {
    const at = t + s * gap;
    // Dice slam into the side of the cup, then clatter against each other.
    thud(ac, at, 0.12, 170 + Math.random() * 40);
    const clicks = 4 + dice * 2;
    for (let i = 0; i < clicks; i++) {
      const when = at + Math.random() * gap * 0.75;
      tick(ac, body, when, 0.35 + Math.random() * 0.35, 900 + Math.random() * 1800, 0.01 + Math.random() * 0.01);
    }
  }
}

/** The dice tumbling out onto the table: each one lands, bounces, and settles. */
function spill(ac: AudioContext, t: number, dice: number) {
  for (let d = 0; d < dice; d++) {
    let at = t + Math.random() * 0.08;
    let gap = 0.07 + Math.random() * 0.03;
    let volume = 0.7 + Math.random() * 0.3;
    const pitch = 1600 + Math.random() * 1400;
    thud(ac, at, 0.22 * volume, 140 + Math.random() * 60);
    // Bounces come quicker and quieter until the die comes to rest.
    for (let b = 0; b < 4; b++) {
      tick(ac, master!, at, 0.55 * volume, pitch * (1 + b * 0.05), 0.02, 1.5);
      at += gap;
      gap *= 0.62;
      volume *= 0.5;
    }
  }
  // A couple of dice clipping each other as they land.
  for (let i = 0; i < 3; i++) tick(ac, master!, t + 0.03 + Math.random() * 0.15, 0.3, 3500 + Math.random() * 1500, 0.008, 3);
}

export const sounds = {
  /** Dice shaken in a cup, then spilled across the table. */
  roll(dice = 5) {
    const ac = audio();
    if (!ac) return;
    const t = ac.currentTime;
    cupShake(ac, t, dice);
    spill(ac, t + SHAKE_MS / 1000, dice);
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
    osc.connect(gain).connect(master!);
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
        setTimeout(() => sounds.bust(), SHAKE_MS + 450);
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
