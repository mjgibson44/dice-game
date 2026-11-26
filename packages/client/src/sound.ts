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

/** The audio context, or null while sound effects are off (unless `force`, for the sound sampler). */
function audio(force = false): AudioContext | null {
  if (muted && !force) return null;
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
function thud(ac: AudioContext, start: number, volume: number, freq: number, out: AudioNode = master!) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, start + 0.05);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + 0.08);
}

interface Bounce {
  /** Where the die's clicks sit, in Hz: lower sounds woodier, higher sounds like hard plastic. */
  pitch: number;
  volume: number;
  bounces: number;
  /** Seconds between landing and the first bounce; each later gap is shorter. */
  gap: number;
  /** Length of each click. Longer clicks with a high q ring like wood. */
  length: number;
  q: number;
  /** A low knock under the first landing, or 0 for none. */
  thud: number;
}

/** One die landing and bouncing to a stop: quicker and quieter each time. */
function bounceDie(ac: AudioContext, out: AudioNode, start: number, b: Bounce) {
  let at = start;
  let gap = b.gap;
  let volume = b.volume;
  if (b.thud) thud(ac, at, b.thud, 110 + Math.random() * 70, out);
  for (let i = 0; i < b.bounces; i++) {
    tick(ac, out, at, volume, b.pitch * (1 + i * 0.04), b.length, b.q);
    at += gap;
    gap *= 0.62;
    volume *= 0.5;
  }
}

/** Dice rattling against each other (and whatever holds them) for a while. */
function rattle(ac: AudioContext, out: AudioNode, start: number, seconds: number, shakes: number, clicksPerShake: number, low: number, high: number, volume: number) {
  const gap = seconds / shakes;
  for (let s = 0; s < shakes; s++) {
    for (let i = 0; i < clicksPerShake; i++) {
      const when = start + s * gap + Math.random() * gap * 0.75;
      tick(ac, out, when, volume * (0.5 + Math.random() * 0.5), low + Math.random() * (high - low), 0.01 + Math.random() * 0.01);
    }
  }
}

function filter(ac: AudioContext, type: BiquadFilterType, frequency: number, q = 1, gain = 0): BiquadFilterNode {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

export interface RollSound {
  id: string;
  /** Which family it belongs to, for grouping in the sampler. */
  group: "Felt tray" | "Retro arcade";
  name: string;
  description: string;
  /** How long after the tap the dice land. The dice animation waits this long too. */
  leadMs: number;
  play: (ac: AudioContext, t: number, dice: number) => void;
}

interface FeltOptions {
  /** Where the cloth cuts off the highs: lower is softer and more muffled. */
  cutoff: number;
  /** Loudness of the low knock as each die lands. */
  weight: number;
  bounces: number;
  /** Seconds the dice keep rolling across the cloth after landing. */
  roll: number;
}

/** Dice landing on a padded felt tray, then rolling briefly across the cloth. */
function feltLanding(ac: AudioContext, t: number, dice: number, o: FeltOptions) {
  const cloth = filter(ac, "lowpass", o.cutoff);
  cloth.connect(master!);
  for (let d = 0; d < dice; d++) {
    bounceDie(ac, cloth, t + Math.random() * 0.08, { pitch: 500 + Math.random() * 300, volume: 1.2, bounces: o.bounces, gap: 0.08, length: 0.035, q: 1, thud: o.weight });
  }
  if (o.roll > 0) rattle(ac, cloth, t + 0.08, o.roll, Math.max(2, Math.round(o.roll * 13)), 3, 300, 800, 0.5);
}

/** Random blips from a scale that start fast and slow down, like dice spinning on a game screen. */
function blips(ac: AudioContext, t: number, seconds: number, type: OscillatorType, volume: number, notes: readonly number[]) {
  let at = t;
  let gap = 0.022;
  while (at < t + seconds) {
    tone(ac, notes[Math.floor(Math.random() * notes.length)]!, at, 0.045, volume, type);
    at += gap;
    gap *= 1.12;
  }
}

const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66];

export const ROLL_SOUNDS: readonly RollSound[] = [
  {
    id: "felt",
    group: "Felt tray",
    name: "Felt tray",
    description: "The original: soft thumps and a short roll.",
    leadMs: 0,
    play: (ac, t, dice) => feltLanding(ac, t, dice, { cutoff: 900, weight: 0.45, bounces: 3, roll: 0.3 }),
  },
  {
    id: "felt-heavy",
    group: "Felt tray",
    name: "Heavy dice",
    description: "Bigger, weightier dice. Deeper knocks, fewer bounces.",
    leadMs: 0,
    play(ac, t, dice) {
      const cloth = filter(ac, "lowpass", 650);
      cloth.connect(master!);
      for (let d = 0; d < dice; d++) {
        const at = t + Math.random() * 0.09;
        thud(ac, at, 0.6, 75 + Math.random() * 25, cloth);
        bounceDie(ac, cloth, at, { pitch: 350 + Math.random() * 200, volume: 1.3, bounces: 2, gap: 0.1, length: 0.045, q: 1, thud: 0 });
      }
      rattle(ac, cloth, t + 0.1, 0.2, 3, 2, 200, 500, 0.45);
    },
  },
  {
    id: "felt-crisp",
    group: "Felt tray",
    name: "Crisp felt",
    description: "Thinner cloth: still soft, but you hear the dice click together.",
    leadMs: 0,
    play(ac, t, dice) {
      feltLanding(ac, t, dice, { cutoff: 1700, weight: 0.35, bounces: 3, roll: 0.25 });
      // Dice nudging each other as they settle.
      rattle(ac, master!, t + 0.05, 0.2, 2, 2, 2500, 3800, 0.18);
    },
  },
  {
    id: "felt-long",
    group: "Felt tray",
    name: "Long roll",
    description: "A harder throw: the dice tumble across the felt for longer.",
    leadMs: 0,
    play: (ac, t, dice) => feltLanding(ac, t, dice, { cutoff: 1000, weight: 0.4, bounces: 4, roll: 0.65 }),
  },
  {
    id: "felt-cup",
    group: "Felt tray",
    name: "Cup onto felt",
    description: "A soft shake in a cup first, then the dice land on felt.",
    leadMs: 300,
    play(ac, t, dice) {
      const cup = filter(ac, "peaking", 700, 3, 8);
      cup.connect(filter(ac, "lowpass", 1400)).connect(master!);
      rattle(ac, cup, t, 0.3, 3, 3 + dice, 700, 1800, 0.6);
      feltLanding(ac, t + 0.3, dice, { cutoff: 900, weight: 0.45, bounces: 3, roll: 0.25 });
    },
  },
  {
    id: "arcade",
    group: "Retro arcade",
    name: "Retro arcade",
    description: "The original: square-wave blips that slow down and land on a chord.",
    leadMs: 360,
    play(ac, t, dice) {
      blips(ac, t, 0.33, "square", 0.06, PENTATONIC);
      const land = t + 0.36;
      tone(ac, 783.99, land, 0.18, 0.08, "square");
      tone(ac, 1046.5, land + 0.05, 0.22, 0.07, "square");
      if (dice > 2) tone(ac, 1318.5, land + 0.1, 0.26, 0.06, "square");
    },
  },
  {
    id: "arcade-soft",
    group: "Retro arcade",
    name: "Soft handheld",
    description: "Rounder triangle-wave blips, like an old handheld. Gentler on the ears.",
    leadMs: 360,
    play(ac, t, dice) {
      blips(ac, t, 0.33, "triangle", 0.14, PENTATONIC);
      const land = t + 0.36;
      tone(ac, 659.25, land, 0.2, 0.16, "triangle");
      tone(ac, 987.77, land + 0.06, 0.28, 0.14, "triangle");
      if (dice > 2) tone(ac, 1318.5, land + 0.12, 0.3, 0.12, "triangle");
    },
  },
  {
    id: "arcade-reels",
    group: "Retro arcade",
    name: "Slot reels",
    description: "A ticking spin, then each die locks in with its own rising note.",
    leadMs: 300,
    play(ac, t, dice) {
      // The spin: even ticks that slow down.
      let at = t;
      let gap = 0.03;
      while (at < t + 0.28) {
        tone(ac, 1568, at, 0.02, 0.05, "square");
        at += gap;
        gap *= 1.15;
      }
      // One note per die, timed with each die flipping into place.
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      for (let d = 0; d < dice; d++) tone(ac, notes[d]!, t + 0.3 + d * 0.045, 0.14, 0.07, "square");
    },
  },
  {
    id: "arcade-noise",
    group: "Retro arcade",
    name: "8-bit clatter",
    description: "Crunchy game-console noise for the rattle, then a quick blip as they land.",
    leadMs: 320,
    play(ac, t, dice) {
      // Short bursts of hissy noise, like an old console's drum channel.
      let at = t;
      let gap = 0.025;
      while (at < t + 0.3) {
        tick(ac, master!, at, 0.35, 2500 + Math.random() * 3000, 0.025, 0.6);
        at += gap;
        gap *= 1.13;
      }
      const land = t + 0.32;
      tick(ac, master!, land, 0.5, 900, 0.06, 0.5);
      tone(ac, 1046.5, land, 0.08, 0.07, "square");
      tone(ac, 1568, land + 0.06, 0.14, 0.06, "square");
      if (dice > 2) tone(ac, 2093, land + 0.12, 0.12, 0.04, "square");
    },
  },
  {
    id: "arcade-coin",
    group: "Retro arcade",
    name: "Bonus coin",
    description: "Quick blips that finish on a bright two-note coin sound.",
    leadMs: 250,
    play(ac, t) {
      blips(ac, t, 0.22, "square", 0.05, [783.99, 880, 1046.5, 1174.66, 1318.5]);
      const land = t + 0.25;
      tone(ac, 987.77, land, 0.07, 0.08, "square");
      tone(ac, 1318.5, land + 0.07, 0.3, 0.08, "square");
    },
  },
];

const ROLL_KEY = "dice-game:roll-sound";
/** What everyone hears unless they pick something else at /sounds. */
const DEFAULT_ROLL_SOUND = "felt";
let rollSound =
  ROLL_SOUNDS.find((r) => r.id === localStorage.getItem(ROLL_KEY)) ?? ROLL_SOUNDS.find((r) => r.id === DEFAULT_ROLL_SOUND)!;
const applyLead = () => document.documentElement.style.setProperty("--shake", `${rollSound.leadMs}ms`);
applyLead();

/** How long after a roll the dice land, for timing the crap-out sound. */
export function rollLeadMs(): number {
  return rollSound.leadMs;
}

export function setRollSound(id: string) {
  rollSound = ROLL_SOUNDS.find((r) => r.id === id) ?? rollSound;
  localStorage.setItem(ROLL_KEY, rollSound.id);
  applyLead();
  for (const l of listeners) l();
}

export function useRollSound(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => rollSound.id,
  );
}

/** Play one roll sound even when sound effects are off (the sampler). */
export function previewRoll(id: string, dice = 5) {
  const ac = audio(true);
  const sound = ROLL_SOUNDS.find((r) => r.id === id);
  if (ac && sound) sound.play(ac, ac.currentTime, dice);
}

export const sounds = {
  /** The dice roll, in whichever style is picked (felt tray unless changed). */
  roll(dice = 5) {
    const ac = audio();
    if (!ac) return;
    rollSound.play(ac, ac.currentTime, dice);
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
        setTimeout(() => sounds.bust(), rollLeadMs() + 450);
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
