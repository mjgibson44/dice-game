import type { Face } from "@dice-game/shared";

// Pip positions on a 3x3 grid, numbered 0-8 left-to-right, top-to-bottom.
const PIPS: Record<Face, number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

interface DieProps {
  face: Face;
  size?: "lg" | "sm";
  selected?: boolean;
  rolling?: boolean;
  hinted?: boolean;
  onClick?: () => void;
}

export function Die({ face, size = "lg", selected = false, rolling = false, hinted = false, onClick }: DieProps) {
  const className = ["die", `die-${size}`, selected && "selected", rolling && "rolling", hinted && "hinted"].filter(Boolean).join(" ");
  const pips = (
    <span className="pips">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={PIPS[face].includes(i) ? "pip" : "pip empty"} />
      ))}
    </span>
  );
  if (!onClick) {
    return (
      <span className={className} role="img" aria-label={`${face}`}>
        {pips}
      </span>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} aria-pressed={selected} aria-label={`Die showing ${face}`}>
      {pips}
    </button>
  );
}
