/**
 * Accessories. Top pieces (sprout, antenna) extend the silhouette in the body
 * colour so the avatar still reads as one shape; worn pieces (beret, bow tie,
 * glasses) use a second colour. Anchored to the body's top or chin at x = 32.
 */
import type { AvatarAccessory, AvatarPaint } from "./avatarConfig";
import type { EyeGeometry } from "./avatarFaces";
import type { BodyGeometry } from "./avatarShapes";

/** Accessories that need headroom above the body. */
export const TOP_ACCESSORIES: ReadonlySet<AvatarAccessory> = new Set([
  "sprout",
  "antenna",
  "halo",
  "beret",
]);

/** Highest point an accessory reaches above the body top, in avatar units. */
export const ACCESSORY_HEADROOM = 12;

export function Accessory(props: {
  kind: AvatarAccessory;
  layer: "back" | "front";
  body: BodyGeometry;
  eyes: readonly EyeGeometry[];
  paint: AvatarPaint;
  tiny: boolean;
}) {
  const { kind, layer, body, paint, tiny } = props;
  const stem = {
    stroke: paint.body,
    strokeWidth: tiny ? 4.5 : 3,
    strokeLinecap: "round" as const,
    fill: "none",
  };
  const onTop = `translate(32 ${body.top})`;

  if (layer === "back") {
    if (kind === "sprout") {
      return (
        <g transform={onTop}>
          <path d="M0 3V-6" {...stem} />
          <g fill={paint.leaf}>
            <path d="M0 -5C-2 -10 -7 -12 -12.5 -11C-11.5 -6 -6.5 -4 0 -5Z" />
            <path d="M0 -6.5C2 -10.5 6.5 -12.5 12 -11.7C11 -7.5 6 -5.5 0 -6.5Z" />
          </g>
        </g>
      );
    }
    if (kind === "antenna") {
      return (
        <g transform={onTop}>
          <path d="M0 3V-6" {...stem} />
          <circle cx={0} cy={-8} r={tiny ? 4.5 : 3.6} fill={paint.body} />
        </g>
      );
    }
    return null;
  }

  if (kind === "glasses" && !tiny) return <Glasses eyes={props.eyes} paint={paint} />;
  if (kind === "halo") {
    return (
      <ellipse
        transform={onTop}
        cx={0}
        cy={-7}
        rx={13}
        ry={3.2}
        fill="none"
        stroke={paint.halo}
        strokeWidth={tiny ? 4.5 : 3}
      />
    );
  }
  if (kind === "beret") {
    return (
      <g transform={`${onTop} rotate(-10)`} fill={paint.accent}>
        <ellipse cx={3} cy={1} rx={16} ry={tiny ? 7 : 5.5} />
        <circle cx={2} cy={-5} r={2.2} />
      </g>
    );
  }
  // A bow at 16px is a smudge, so it's only drawn larger.
  if (kind === "bowtie" && !tiny) {
    return (
      <g transform={`translate(32 ${body.bottom - 5})`} fill={paint.accent}>
        <path d="M0 0L-8.5 -5Q-10 0 -8.5 5ZM0 0L8.5 -5Q10 0 8.5 5Z" strokeLinejoin="round" />
        <circle cx={0} cy={0} r={2.4} />
      </g>
    );
  }
  return null;
}

/** Dark round frames centred on the eyes, nudged apart when the eyes sit close. */
function Glasses(props: { eyes: readonly EyeGeometry[]; paint: AvatarPaint }) {
  const [left, right] = props.eyes;
  if (!left || !right) return null;
  const r = Math.max(left.w, left.h, right.w, right.h) / 2 + 2;
  const [lx, ly, rx, ry] = [left.matrix[4], left.matrix[5], right.matrix[4], right.matrix[5]];
  const len = Math.hypot(rx - lx, ry - ly) || 1;
  const ux = (rx - lx) / len;
  const uy = (ry - ly) / len;
  const half = Math.max(len / 2, r + 1.2);
  const mx = (lx + rx) / 2;
  const my = (ly + ry) / 2;
  const a = [mx - ux * half, my - uy * half] as const;
  const b = [mx + ux * half, my + uy * half] as const;
  return (
    <g fill="none" stroke={props.paint.accent} strokeWidth={2.2} strokeLinecap="round">
      <circle cx={a[0]} cy={a[1]} r={r} />
      <circle cx={b[0]} cy={b[1]} r={r} />
      <path d={`M${a[0] + ux * r} ${a[1] + uy * r}L${b[0] - ux * r} ${b[1] - uy * r}`} />
    </g>
  );
}
