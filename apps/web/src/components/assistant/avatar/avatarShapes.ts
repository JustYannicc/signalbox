/**
 * Body silhouettes on a 64-unit box, as SVG path data built once at import.
 * Every body is centred near (32, 35) with a ~22-unit radius so faces and
 * accessories line up across shapes. Shape recipes adapted from bloub's
 * customiser (MIT, https://github.com/jeremy-prt/bloub, src/bot/skins.ts).
 */
import type { AvatarShape } from "./avatarConfig";

export const BODY_RADIUS = 22;
const CX = 32;
const CY = 35;

export interface BodyGeometry {
  d: string;
  /** Head top and chin at x = 32; accessories hang off these. */
  top: number;
  bottom: number;
  /** Face centre and how far the eyes may wander from it. */
  faceX: number;
  faceY: number;
  spread: number;
}

type Point = readonly [number, number];
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Closed Catmull-Rom spline through the points: smooth at any size. */
function smoothPath(points: readonly Point[]): string {
  const n = points.length;
  const at = (i: number) => points[(i + n) % n]!;
  let d = `M${fmt(at(0)[0])} ${fmt(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fmt(c1[0]!)} ${fmt(c1[1]!)} ${fmt(c2[0]!)} ${fmt(c2[1]!)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return `${d}Z`;
}

/** Samples r(theta) (in body radii) around (cx, cy). */
function radial(r: (theta: number) => number, cx = CX, cy = CY, samples = 72): Point[] {
  return Array.from({ length: samples }, (_, i) => {
    const theta = (i / samples) * Math.PI * 2;
    const radius = r(theta) * BODY_RADIUS;
    return [cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius] as const;
  });
}

/** Regular polygon with corners rounded by quadratic curves through each vertex. */
function roundedPolygon(sides: number, radius: number, rotation: number, cy: number, t: number) {
  const vertices = Array.from({ length: sides }, (_, i) => {
    const a = ((rotation + (360 / sides) * i) * Math.PI) / 180;
    return [CX + Math.cos(a) * radius, cy + Math.sin(a) * radius] as const;
  });
  const lerp = (a: Point, b: Point, k: number) =>
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] as const;
  const corners = vertices.map((v, i) => ({
    v,
    a: lerp(v, vertices[(i - 1 + sides) % sides]!, t),
    b: lerp(v, vertices[(i + 1) % sides]!, t),
  }));
  const last = corners[sides - 1]!.b;
  const d = corners.reduce(
    (acc, c) =>
      `${acc}L${fmt(c.a[0])} ${fmt(c.a[1])}Q${fmt(c.v[0])} ${fmt(c.v[1])} ${fmt(c.b[0])} ${fmt(c.b[1])}`,
    `M${fmt(last[0])} ${fmt(last[1])}`,
  );
  return { d: `${d}Z`, corners };
}

/** Far intersection of a ray from the origin with a union of circles. */
function unionOfCircles(circles: readonly (readonly [number, number, number])[]) {
  return (theta: number) => {
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    let best = 0;
    for (const [x, y, r] of circles) {
      const along = dx * x + dy * y;
      const disc = along * along - (x * x + y * y) + r * r;
      if (disc >= 0) best = Math.max(best, along + Math.sqrt(disc));
    }
    return best;
  };
}

function fromPoints(points: Point[], face: Omit<BodyGeometry, "d" | "top" | "bottom">) {
  const near = points.filter(([x]) => Math.abs(x - CX) < 4).map(([, y]) => y);
  return { d: smoothPath(points), top: Math.min(...near), bottom: Math.max(...near), ...face };
}

const R = BODY_RADIUS;
const centred = { faceX: CX, faceY: CY, spread: 1 };

const triangle = roundedPolygon(3, R * 1.18, -90, CY + 5, 0.3);
const triangleTip = triangle.corners[0]!;
const hexagon = roundedPolygon(6, R * 1.06, 0, CY, 0.24);

// Droplet: a big disc with tangents running up to a small rounded tip.
const drop = { cy: 42, r: 17.5, tipY: 9 };
const dropSin = drop.r / (drop.cy - drop.tipY);
const dropAngle = Math.PI / 2 - Math.asin(dropSin);
const dropX = Math.sin(dropAngle) * drop.r;
const dropY = drop.cy - Math.cos(dropAngle) * drop.r;

export const BODIES: Record<AvatarShape, BodyGeometry> = {
  circle: {
    d: `M${CX - R} ${CY}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0Z`,
    top: CY - R,
    bottom: CY + R,
    ...centred,
  },
  pebble: fromPoints(
    radial((a) => 0.98 * (1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1))),
    centred,
  ),
  squircle: fromPoints(
    radial(
      (a) => 0.98 * (Math.abs(Math.cos(a)) ** 4.2 + Math.abs(Math.sin(a)) ** 4.2) ** (-1 / 4.2),
    ),
    centred,
  ),
  capsule: {
    d: `M${CX - 10} ${CY - 14}h20a14 14 0 0 1 0 28h-20a14 14 0 0 1 0 -28Z`,
    top: CY - 14,
    bottom: CY + 14,
    faceX: CX,
    faceY: CY,
    spread: 0.75,
  },
  triangle: {
    d: triangle.d,
    top: 0.25 * triangleTip.a[1] + 0.5 * triangleTip.v[1] + 0.25 * triangleTip.b[1],
    bottom: CY + 5 + R * 1.18 * 0.5,
    faceX: CX,
    faceY: CY + 9,
    spread: 0.55,
  },
  hexagon: {
    d: hexagon.d,
    top: CY - R * 1.06 * Math.sin(Math.PI / 3),
    bottom: CY + R * 1.06 * Math.sin(Math.PI / 3),
    faceX: CX,
    faceY: CY,
    spread: 0.85,
  },
  cloud: fromPoints(
    radial(
      unionOfCircles([
        [-0.44, 0.2, 0.54],
        [0.46, 0.2, 0.5],
        [0.02, 0.3, 0.6],
        [-0.24, -0.3, 0.48],
        [0.3, -0.24, 0.44],
      ]),
      CX,
      CY - 2,
      96,
    ),
    { faceX: CX, faceY: CY + 1, spread: 0.8 },
  ),
  droplet: {
    d:
      `M${CX} ${drop.tipY - 1}Q${CX + 1.6} ${drop.tipY - 1} ${CX + 2.2} ${drop.tipY + 1.4}` +
      `L${fmt(CX + dropX)} ${fmt(dropY)}A${drop.r} ${drop.r} 0 1 1 ${fmt(CX - dropX)} ${fmt(dropY)}` +
      `L${CX - 2.2} ${drop.tipY + 1.4}Q${CX - 1.6} ${drop.tipY - 1} ${CX} ${drop.tipY - 1}Z`,
    top: drop.tipY - 1,
    bottom: drop.cy + drop.r,
    faceX: CX,
    faceY: drop.cy + 1,
    spread: 0.62,
  },
};

/**
 * Harness bodies: silhouettes drawn from each lab's mark, for `HarnessAvatar`.
 * Not user-pickable (kept out of `AVATAR_SHAPES`); same frame and face rules.
 */
export const LAB_SHAPES = ["burst", "hexafoil", "cross", "cube", "block"] as const;
export type LabShape = (typeof LAB_SHAPES)[number];

const hexafoilCircles = Array.from({ length: 6 }, (_, i) => {
  const a = (i * Math.PI) / 3 + Math.PI / 6;
  return [Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0.5] as const;
});
const cube = roundedPolygon(6, R * 1.08, -90, CY, 0.18);
const block = roundedPolygon(4, R * 1.28, 45, CY, 0.22);

export const LAB_BODIES: Record<LabShape, BodyGeometry> = {
  // Claude's starburst: soft rays around a round middle.
  burst: fromPoints(
    radial((a) => 0.88 + 0.13 * Math.cos(10 * a - Math.PI / 2), CX, CY, 120),
    { faceX: CX, faceY: CY + 1, spread: 0.72 },
  ),
  // OpenAI's knot, read as a six-petal flower.
  hexafoil: fromPoints(radial(unionOfCircles([[0, 0, 0.62], ...hexafoilCircles]), CX, CY, 108), {
    faceX: CX,
    faceY: CY + 1,
    spread: 0.8,
  }),
  // xAI's X: four rounded arms off a solid middle.
  cross: fromPoints(
    radial((a) => 0.62 + 0.42 * Math.abs(Math.cos(2 * (a - Math.PI / 4))) ** 5, CX, CY, 144),
    { faceX: CX, faceY: CY + 1, spread: 0.6 },
  ),
  // Cursor's cube: a pointy-top hexagon.
  cube: {
    d: cube.d,
    top: CY - R * 1.08 + 2,
    bottom: CY + R * 1.08 - 2,
    faceX: CX,
    faceY: CY + 2,
    spread: 0.8,
  },
  // OpenCode's block: a rounded square.
  block: {
    d: block.d,
    top: CY - R * 1.28 * Math.SQRT1_2,
    bottom: CY + R * 1.28 * Math.SQRT1_2,
    faceX: CX,
    faceY: CY,
    spread: 0.85,
  },
};
