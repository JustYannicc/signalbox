/**
 * Eyes painted on a sphere. The whole face is two small eyes, so every mood is
 * a head pose (yaw / pitch / roll), an eye spacing, and each eye's size and
 * tilt. Projecting the eyes onto a sphere gives the foreshortening and the
 * signature `\\` lean for free.
 *
 * Model and face values adapted from bloub (MIT, Jeremy Perret,
 * https://github.com/jeremy-prt/bloub, src/bot/face.ts and expressions.ts),
 * which measured them off the x.ai bot avatar. Pure math, no React.
 */
import type { AvatarExpression, AvatarFace, AvatarEyes } from "./avatarConfig";

interface Gaze {
  /** degrees, positive looks right */
  yaw: number;
  /** degrees, positive looks up */
  pitch: number;
  /** degrees, head tilt */
  roll: number;
}

interface EyeCfg {
  /** width and height in body radii */
  w: number;
  h: number;
  /** degrees, positive leans the top of the eye right */
  tilt: number;
  /** 1 open, 0 shut (a vertical squash) */
  open: number;
}

export interface FacePose {
  gaze: Gaze;
  /** half the angle between the eyes on the sphere, degrees */
  split: number;
  eyes: readonly [EyeCfg, EyeCfg];
}

const eye = (w: number, h: number, tilt = 0, open = 1): EyeCfg => ({ w, h, tilt, open });
const pair = (w: number, h: number, tilt = 0, open = 1) =>
  [eye(w, h, tilt, open), eye(w, h, -tilt, open)] as const;
const pose = (yaw: number, pitch: number, roll: number, split: number, eyes: FacePose["eyes"]) => ({
  gaze: { yaw, pitch, roll },
  split,
  eyes,
});

export const FACE_POSES: Record<AvatarFace, FacePose> = {
  neutral: pose(28.49, 28.62, -13, 15.46, pair(0.186, 0.412)),
  attentive: pose(4, 5, -4, 16, pair(0.21, 0.44)),
  happy: pose(5, 9, 0, 17, pair(0.27, 0.17, 14)),
  laughing: pose(4, 14, 0, 18, pair(0.34, 0.13, 20)),
  excited: pose(6, -14, 0, 19.5, pair(0.4, 0.56, -10)),
  surprised: pose(3, -3, 0, 19, pair(0.45, 0.47)),
  curious: pose(16, -9, -15, 16.5, [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)]),
  proud: pose(5, 17, 0, 17, pair(0.3, 0.15, 18)),
  shy: pose(-19, -14, -7, 14, pair(0.17, 0.3)),
  sleepy: pose(6, -9, -3, 16, pair(0.2, 0.42, 0, 0.42)),
  unimpressed: pose(-22, 2, 0, 16, pair(0.3, 0.12)),
  suspicious: pose(12, 6, -6, 16, [eye(0.21, 0.4), eye(0.22, 0.15)]),
};

/** Transient moods borrow a face; "thinking" glances up and away. */
const THINKING = pose(-18, 22, 6, 15.5, pair(0.2, 0.34));

export function facePose(face: AvatarFace, expression: AvatarExpression): FacePose {
  switch (expression) {
    case "thinking":
      return THINKING;
    case "happy":
      return FACE_POSES.happy;
    case "listening":
      return FACE_POSES.attentive;
    case "idle":
      return FACE_POSES[face];
  }
}

type Vec3 = readonly [number, number, number];
const rad = (d: number) => (d * Math.PI) / 180;

/** Rotates two orthonormal vectors within their shared plane. */
function spin(u: Vec3, v: Vec3, angle: number): [Vec3, Vec3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

export interface EyeGeometry {
  side: "left" | "right";
  /** width and height in avatar units, before the frame transform */
  w: number;
  h: number;
  /** SVG `matrix()` args placing the eye: tangent frame x tilt x lid, then position */
  matrix: readonly [number, number, number, number, number, number];
}

export interface EyeLayout {
  /** body radius in avatar units */
  radius: number;
  /** centre of the face in avatar units */
  cx: number;
  cy: number;
  /** squeezes eye positions towards the centre on narrow shapes */
  spread: number;
  /** 16px mode: face the viewer more and fatten the eyes so they survive */
  tiny: boolean;
  style: AvatarEyes;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Both eyes' size and placement for a pose, ready to draw as SVG. */
export function layoutEyes(face: FacePose, layout: EyeLayout): EyeGeometry[] {
  const damp = layout.tiny ? 0.45 : 1;
  const { yaw, pitch, roll } = face.gaze;
  let f: Vec3 = [0, 0, 1];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];
  [f, right] = spin(f, right, rad(yaw * damp));
  [down, f] = spin(down, f, rad(pitch * damp));
  [right, down] = spin(right, down, rad(roll * damp));

  const split = layout.tiny ? face.split * 1.25 : face.split;
  const out: EyeGeometry[] = [];
  for (const [index, side] of [-1, 1].entries()) {
    const [ef, er] = spin(f, right, rad(split * side));
    if (ef[2] <= 0.02) continue;
    const cfg = face.eyes[index]!;
    // Diamonds stay upright gems (Dots-style): only tilt and head roll turn
    // them, since the sphere's skew reads as a broken parallelogram.
    const [tx, ty, dx, dy] =
      layout.style === "diamond" ? [1, 0, 0, 1] : [er[0], er[1], down[0], down[1]];
    const tilt = rad(cfg.tilt + (layout.style === "diamond" ? roll * damp : 0));
    const cp = Math.cos(tilt);
    const sp = Math.sin(tilt);
    const ax = tx * cp + dx * sp;
    const ay = ty * cp + dy * sp;
    const cx = -tx * sp + dx * cp;
    const cy = -ty * sp + dy * cp;
    const x = layout.cx + ef[0] * layout.radius * layout.spread;
    const y = layout.cy + ef[1] * layout.radius * layout.spread;
    // Lids squash vertically on screen, not along the eye's own axis.
    const lid = 0.06 + 0.94 * cfg.open;
    out.push({
      side: side < 0 ? "left" : "right",
      ...eyeSize(cfg, layout),
      matrix: [round2(ax), round2(ay * lid), round2(cx), round2(cy * lid), round2(x), round2(y)],
    });
  }
  return out;
}

function eyeSize(cfg: EyeCfg, layout: EyeLayout) {
  let w = cfg.w * layout.radius;
  let h = cfg.h * layout.radius;
  if (layout.tiny) {
    w *= 1.8;
    h *= 1.2;
  }
  if (layout.style === "diamond") {
    // A rhombus has half its box's area; widen it so it weighs like a capsule.
    w *= 1.25;
    h *= 1.05;
  }
  if (layout.style === "round" && h >= w) {
    const d = Math.sqrt(w * h) * 1.15;
    w = d;
    h = d;
  }
  return { w: round2(w), h: round2(h) };
}
