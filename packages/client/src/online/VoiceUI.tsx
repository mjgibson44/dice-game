import type { VoiceStatus } from "@dice-game/shared";
import { voice, useVoice } from "./voice.ts";

function MicIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" stroke="var(--bad)" strokeWidth="2.5" />}
    </svg>
  );
}

/** Small mic next to a player's name: shown while they're in voice, rings pulse while they talk. */
export function VoiceBadge({ status, talking }: { status: VoiceStatus; talking: boolean }) {
  if (status === "off") return null;
  const muted = status === "muted";
  const label = muted ? "in voice, muted" : talking ? "talking" : "in voice";
  return (
    <span className={`voice-badge${talking && !muted ? " talking" : ""}${muted ? " muted" : ""}`} role="img" aria-label={label}>
      <MicIcon off={muted} />
    </span>
  );
}

/** Join voice / mute toggle for the top bar and lobby. */
export function MicButton({ me, compact = false }: { me: string; compact?: boolean }) {
  const v = useVoice();
  if (v.status === "off") {
    return (
      <button type="button" className="mic-button join" onClick={() => void voice.join(me)}>
        <MicIcon /> {compact ? "Voice" : "Join voice"}
      </button>
    );
  }
  if (v.status === "joining") {
    return (
      <button type="button" className="mic-button" disabled>
        <MicIcon /> …
      </button>
    );
  }
  const talking = v.talking.has(me) && !v.muted;
  return (
    <button
      type="button"
      className={`mic-button live${v.muted ? " muted" : ""}${talking ? " talking" : ""}`}
      onClick={() => voice.setMuted(!v.muted)}
      aria-label={v.muted ? "Unmute microphone" : "Mute microphone"}
      aria-pressed={v.muted}
    >
      <MicIcon off={v.muted} />
      {!compact && (v.muted ? " Muted" : " Mic on")}
    </button>
  );
}

/** Voice settings for the ☰ menu: on/off, mute, your mic level, and how loud others are. */
export function VoiceSettings({ me }: { me: string }) {
  const v = useVoice();
  const on = v.status === "on";
  return (
    <div className="panel settings">
      <label className="setting-row">
        <span>Voice chat</span>
        <input
          type="checkbox"
          className="switch"
          checked={v.status !== "off"}
          disabled={v.status === "joining"}
          onChange={(e) => (e.target.checked ? void voice.join(me) : voice.leave())}
        />
      </label>
      {on && (
        <>
          <label className="setting-row">
            <span>Microphone</span>
            <input type="checkbox" className="switch" checked={!v.muted} onChange={(e) => voice.setMuted(!e.target.checked)} />
          </label>
          <div className="setting-row">
            <span className="muted">Mic level</span>
            <span className="level-meter" aria-label="Microphone level">
              <span style={{ transform: `scaleX(${v.muted ? 0 : v.micLevel})` }} />
            </span>
          </div>
          <label className="setting-row">
            <span className="muted">Voices volume</span>
            <input type="range" min="0" max="1" step="0.05" value={v.volume} onChange={(e) => voice.setVolume(Number(e.target.value))} />
          </label>
        </>
      )}
      {v.error && <p className="bad small">{v.error}</p>}
    </div>
  );
}
