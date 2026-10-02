/**
 * The assistant avatar's data model: a small serializable config, the curated
 * option lists, the colour palette, and a seed -> config generator.
 *
 * The look follows the Grok bot / OpenAI Dots family: one flat, solid
 * silhouette, two small eyes cut out of it, no mouth. Personality comes from
 * the eyes' pose (see `avatarFaces.ts`) and an optional accessory.
 * Pure logic only; rendering lives in `AssistantAvatar`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const AVATAR_SHAPES = [
  "circle",
  "pebble",
  "squircle",
  "capsule",
  "triangle",
  "hexagon",
  "cloud",
  "droplet",
] as const;
export const AVATAR_COLORS = [
  "ink",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "grey",
] as const;
/** Resting face: how the eyes sit when nothing is happening. */
export const AVATAR_FACES = [
  "neutral",
  "attentive",
  "happy",
  "laughing",
  "excited",
  "surprised",
  "curious",
  "proud",
  "shy",
  "sleepy",
  "unimpressed",
  "suspicious",
] as const;
export const AVATAR_EYES = ["capsule", "round", "diamond"] as const;
export const AVATAR_ACCESSORIES = [
  "none",
  "sprout",
  "antenna",
  "halo",
  "glasses",
  "beret",
  "bowtie",
] as const;
/** Transient moods other screens drive; not part of the saved config. */
export const AVATAR_EXPRESSIONS = ["idle", "thinking", "happy", "listening"] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
export type AvatarFace = (typeof AVATAR_FACES)[number];
export type AvatarEyes = (typeof AVATAR_EYES)[number];
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

export interface AssistantAvatarConfig {
  readonly shape: AvatarShape;
  readonly color: AvatarColor;
  readonly face: AvatarFace;
  readonly eyes: AvatarEyes;
  readonly accessory: AvatarAccessory;
}

/** Appa: a sky-blue cloud (a flying bison deserves one) with a calm, open face. */
export const APPA_AVATAR: AssistantAvatarConfig = {
  shape: "cloud",
  color: "blue",
  face: "neutral",
  eyes: "capsule",
  accessory: "none",
};

export const DEFAULT_ASSISTANT_AVATAR: AssistantAvatarConfig = APPA_AVATAR;

/**
 * A field that never fails: unknown or missing values (older saved configs,
 * renamed options) decode to the default instead of throwing the whole
 * config away.
 */
function tolerant<const L extends readonly [string, ...string[]]>(values: L, fallback: L[number]) {
  const withDefault = Schema.withDecodingDefaultKey<Schema.Literals<L>>(Effect.succeed(fallback))(
    Schema.Literals(values),
  );
  return Schema.catchDecoding<typeof withDefault>(() => Effect.succeed(Option.some(fallback)))(
    withDefault,
  );
}

/** Decodes anything object-shaped; a non-object falls back to the default look. */
const AvatarConfigFields = Schema.Struct({
  shape: tolerant(AVATAR_SHAPES, DEFAULT_ASSISTANT_AVATAR.shape),
  color: tolerant(AVATAR_COLORS, DEFAULT_ASSISTANT_AVATAR.color),
  face: tolerant(AVATAR_FACES, DEFAULT_ASSISTANT_AVATAR.face),
  eyes: tolerant(AVATAR_EYES, DEFAULT_ASSISTANT_AVATAR.eyes),
  accessory: tolerant(AVATAR_ACCESSORIES, DEFAULT_ASSISTANT_AVATAR.accessory),
});
export const AssistantAvatarConfigSchema = Schema.catchDecoding<typeof AvatarConfigFields>(() =>
  Effect.succeed(Option.some(DEFAULT_ASSISTANT_AVATAR)),
)(AvatarConfigFields);

/**
 * Base hue per palette entry, built only from theme tokens so every theme
 * (including custom app themes) recolours the avatar. Mixed in oklch so blends
 * like primary + destructive swing through purple instead of going muddy.
 */
const COLOR_BASE: Record<Exclude<AvatarColor, "ink">, string> = {
  red: "var(--color-destructive)",
  orange: "color-mix(in oklch, var(--color-warning) 55%, var(--color-destructive))",
  amber: "var(--color-warning)",
  green: "var(--color-success)",
  teal: "color-mix(in oklch, var(--color-success) 55%, var(--color-info))",
  blue: "var(--color-info)",
  purple: "color-mix(in oklch, var(--color-primary) 60%, var(--color-destructive))",
  pink: "color-mix(in oklch, var(--color-destructive) 60%, var(--color-primary))",
  grey: "var(--color-muted-foreground)",
};

export interface AvatarPaint {
  /** The silhouette. */
  body: string;
  /** What shows through the eye holes. */
  eye: string;
  /** Second colour for beret and bow tie. */
  accent: string;
  /** Fixed accessory colours: sprout leaves stay green, halos stay gold. */
  leaf: string;
  halo: string;
}

const LEAF = "var(--color-success)";
const HALO = "color-mix(in oklab, var(--color-warning) 85%, var(--color-white))";

export function avatarPaint(color: AvatarColor): AvatarPaint {
  // Ink is the Grok bot's black ball; following the theme's foreground keeps it
  // visible on dark backgrounds, with background-coloured eyes as true holes.
  if (color === "ink") {
    return {
      body: "var(--color-foreground)",
      eye: "var(--color-background)",
      accent: "var(--color-destructive)",
      leaf: LEAF,
      halo: HALO,
    };
  }
  const base = COLOR_BASE[color];
  return {
    body: base,
    eye: "var(--color-white)",
    accent: `color-mix(in oklab, ${base} 45%, var(--color-black))`,
    leaf: LEAF,
    halo: HALO,
  };
}

/** cyrb53-style 32-bit string hash: stable across runtimes, good spread. */
export function hashSeed(seed: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** mulberry32: tiny deterministic PRNG returning floats in [0, 1). */
function mulberry32(state: number) {
  let a = state;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(random: () => number, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

/**
 * Same seed, same avatar. Weights lean towards friendly faces and bare heads
 * so any seed is presentable.
 */
export function generateAvatar(seed: string): AssistantAvatarConfig {
  const random = mulberry32(hashSeed(seed));
  return {
    shape: pickWeighted(random, {
      circle: 3,
      pebble: 3,
      squircle: 2,
      capsule: 2,
      triangle: 1,
      hexagon: 1,
      cloud: 2,
      droplet: 2,
    }),
    color: pickWeighted(random, {
      ink: 3,
      red: 1,
      orange: 2,
      amber: 2,
      green: 2,
      teal: 2,
      blue: 2,
      purple: 2,
      pink: 2,
      grey: 1,
    }),
    face: pickWeighted(random, {
      neutral: 4,
      attentive: 3,
      happy: 3,
      laughing: 1,
      excited: 2,
      surprised: 1,
      curious: 2,
      proud: 1,
      shy: 1,
      sleepy: 1,
      unimpressed: 1,
      suspicious: 1,
    }),
    eyes: pickWeighted(random, { capsule: 5, round: 2, diamond: 2 }),
    accessory: pickWeighted(random, {
      none: 6,
      sprout: 2,
      antenna: 2,
      halo: 1,
      glasses: 1,
      beret: 1,
      bowtie: 1,
    }),
  };
}

/** A fresh random seed for "Shuffle"; not cryptographic, just varied. */
export function randomAvatarSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
