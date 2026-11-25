/**
 * Voice chat: audio goes straight between players' browsers (WebRTC), with the
 * game's WebSocket used only to set connections up. Everyone in voice
 * connects to everyone else (fine for up to 5 players).
 *
 * Who's talking is worked out on each device from the audio itself, so the
 * talking animation needs no server traffic.
 */

import type { RoomView, VoiceSignal, VoiceStatus } from "@dice-game/shared";
import { useSyncExternalStore } from "react";
import { connection } from "./connection.ts";

const VOLUME_KEY = "dice-game:voice-volume";
/** Above this loudness (RMS of the waveform) someone counts as talking. */
const TALK_THRESHOLD = 0.02;
/** Keep the talking animation on briefly between words so it doesn't flicker. */
const TALK_HOLD_MS = 350;

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  pendingCandidates: RTCIceCandidateInit[];
}

export interface VoiceState {
  status: "off" | "joining" | "on";
  muted: boolean;
  error: string | null;
  /** Player ids talking right now (including you, while unmuted). */
  talking: ReadonlySet<string>;
  /** Your microphone level, 0-1, for the menu meter. */
  micLevel: number;
  /** How loud other players are, 0-1. */
  volume: number;
}

class VoiceChat {
  private me: string | null = null;
  private local: MediaStream | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private peers = new Map<string, Peer>();
  private ac: AudioContext | null = null;
  private iceServers: RTCIceServer[] = [];
  private meter: ReturnType<typeof setInterval> | null = null;
  private lastLoud = new Map<string, number>();
  private listeners = new Set<() => void>();
  private lastRoom: RoomView | null = null;
  private state: VoiceState = {
    status: "off",
    muted: false,
    error: null,
    talking: new Set(),
    micLevel: 0,
    volume: Number(localStorage.getItem(VOLUME_KEY) ?? "1"),
  };

  constructor() {
    connection.onVoice((from, signal) => void this.onSignal(from, signal));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private sendStatus() {
    const status: VoiceStatus = this.state.status !== "on" ? "off" : this.state.muted ? "muted" : "on";
    connection.send({ type: "voiceState", status });
  }

  /** Turn the mic on and connect to everyone else in voice. Must run from a tap (browsers require it). */
  async join(me: string) {
    if (this.state.status !== "off") return;
    this.me = me;
    this.set({ status: "joining", error: null });
    // The audio context has to be created/resumed during the tap, before any awaits.
    this.ac ??= new AudioContext();
    void this.ac.resume();
    try {
      const [ice, stream] = await Promise.all([
        fetch("/api/ice")
          .then((r) => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
          .catch(() => ({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] })),
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      ]);
      this.iceServers = ice.iceServers;
      this.local = stream;
      this.localAnalyser = this.analyse(stream);
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      this.set({
        status: "off",
        error: denied ? "Microphone access was blocked. Allow it in your browser settings to use voice." : "Couldn't start the microphone.",
      });
      return;
    }
    this.set({ status: "on", muted: false });
    this.sendStatus();
    this.meter = setInterval(() => this.measure(), 100);
    if (this.lastRoom) this.sync(this.lastRoom, me);
  }

  leave() {
    if (this.state.status === "off") return;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.localAnalyser = null;
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    this.set({ status: "off", muted: false, talking: new Set(), micLevel: 0 });
    this.sendStatus();
  }

  setMuted(muted: boolean) {
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
    this.sendStatus();
  }

  setVolume(volume: number) {
    localStorage.setItem(VOLUME_KEY, String(volume));
    for (const peer of this.peers.values()) peer.audio.volume = volume;
    this.set({ volume });
  }

  /** Called on every room update: connect to new voice members, drop ones who left. */
  sync(room: RoomView, me: string) {
    this.lastRoom = room;
    this.me = me;
    if (this.state.status !== "on") return;
    for (const member of room.members) {
      if (member.id === me) continue;
      const wanted = member.connected && member.voice !== "off";
      const peer = this.peers.get(member.id);
      if (peer && (!wanted || peer.pc.connectionState === "failed" || peer.pc.connectionState === "closed")) {
        this.closePeer(member.id);
      }
      // The player with the smaller id calls; the other answers. That way two people never call each other at once.
      if (wanted && !this.peers.has(member.id) && me < member.id) void this.call(member.id);
    }
    for (const id of this.peers.keys()) {
      if (!room.members.some((m) => m.id === id)) this.closePeer(id);
    }
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.volume = this.state.volume;
    const peer: Peer = { pc, audio, analyser: null, pendingCandidates: [] };
    this.local?.getTracks().forEach((track) => pc.addTrack(track, this.local!));
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const { candidate, sdpMid, sdpMLineIndex } = e.candidate;
        connection.send({ type: "voice", to: id, signal: { kind: "candidate", candidate: { candidate, sdpMid, sdpMLineIndex } } });
      }
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = stream;
      void audio.play().catch(() => undefined);
      peer.analyser = this.analyse(stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && this.lastRoom && this.me) {
        this.closePeer(id);
        this.sync(this.lastRoom, this.me);
      }
    };
    this.peers.set(id, peer);
    return peer;
  }

  private async call(id: string) {
    const peer = this.createPeer(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    connection.send({ type: "voice", to: id, signal: { kind: "offer", sdp: offer.sdp ?? "" } });
  }

  private async onSignal(from: string, signal: VoiceSignal) {
    if (this.state.status !== "on") return;
    try {
      if (signal.kind === "offer") {
        // A fresh offer replaces any old connection with this player.
        if (this.peers.has(from)) this.closePeer(from);
        const peer = this.createPeer(from);
        await peer.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await this.flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        connection.send({ type: "voice", to: from, signal: { kind: "answer", sdp: answer.sdp ?? "" } });
      } else if (signal.kind === "answer") {
        const peer = this.peers.get(from);
        if (!peer || peer.pc.signalingState !== "have-local-offer") return;
        await peer.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        await this.flushCandidates(peer);
      } else if (signal.kind === "candidate") {
        const peer = this.peers.get(from);
        if (!peer) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
        else peer.pendingCandidates.push(signal.candidate);
      }
    } catch {
      // A broken set-up is retried on the next room update.
      this.closePeer(from);
    }
  }

  private async flushCandidates(peer: Peer) {
    for (const c of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(c).catch(() => undefined);
  }

  private closePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.close();
    peer.audio.srcObject = null;
  }

  private analyse(stream: MediaStream): AnalyserNode | null {
    if (!this.ac) return null;
    const analyser = this.ac.createAnalyser();
    analyser.fftSize = 512;
    this.ac.createMediaStreamSource(stream).connect(analyser);
    return analyser;
  }

  private measure() {
    const now = Date.now();
    const level = (a: AnalyserNode | null) => {
      if (!a) return 0;
      const data = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      return Math.sqrt(sum / data.length);
    };
    const micLevel = this.state.muted ? 0 : level(this.localAnalyser);
    if (this.me && micLevel > TALK_THRESHOLD) this.lastLoud.set(this.me, now);
    for (const [id, peer] of this.peers) if (level(peer.analyser) > TALK_THRESHOLD) this.lastLoud.set(id, now);

    const talking = new Set([...this.lastLoud].filter(([, t]) => now - t < TALK_HOLD_MS).map(([id]) => id));
    const changed = talking.size !== this.state.talking.size || [...talking].some((id) => !this.state.talking.has(id));
    // Scale for the meter so normal speech fills most of it.
    const meter = Math.min(1, micLevel * 6);
    if (changed || Math.abs(meter - this.state.micLevel) > 0.02) this.set({ talking, micLevel: meter });
  }
}

export const voice = new VoiceChat();

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, voice.getState);
}
