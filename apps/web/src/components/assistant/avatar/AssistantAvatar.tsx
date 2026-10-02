import { useId } from "react";

import { cn } from "~/lib/utils";
import { Accessory, ACCESSORY_HEADROOM, TOP_ACCESSORIES } from "./avatarAccessories";
import {
  avatarPaint,
  type AssistantAvatarConfig,
  type AvatarEyes,
  type AvatarExpression,
} from "./avatarConfig";
import { facePose, layoutEyes, type EyeGeometry } from "./avatarFaces";
import { BODIES, BODY_RADIUS, type BodyGeometry } from "./avatarShapes";

// Mask luminance, not theme colours: white keeps, black drops.
const MASK_KEEP = "white";

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const cssMatrix = (m: EyeGeometry["matrix"]) => `matrix(${m.join(",")})`;

function Eye(props: { eye: EyeGeometry; style: AvatarEyes }) {
  const { eye } = props;
  const { w, h } = eye;
  return (
    <g
      style={{ transform: cssMatrix(eye.matrix), transition: `transform 240ms ${EASE}` }}
      className="motion-reduce:transition-none"
    >
      {props.style === "capsule" && (
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(w, h) / 2} />
      )}
      {props.style === "round" && <ellipse rx={w / 2} ry={h / 2} />}
      {props.style === "diamond" && (
        <path
          d={`M0 ${-h / 2}L${w / 2} 0L0 ${h / 2}L${-w / 2} 0Z`}
          strokeWidth={Math.min(w, h) * 0.3}
          strokeLinejoin="round"
        />
      )}
    </g>
  );
}

/**
 * The assistant's little face: one flat silhouette with two eyes, after the
 * Grok bot and OpenAI Dots avatars. Crisp at any `size` (px); at 20px and
 * below the eyes turn to face the viewer and fatten so they survive.
 *
 * `expression` re-poses the eyes with one eased glide. Pass `label` when the
 * avatar stands alone.
 */
export function AssistantAvatar(props: {
  config: AssistantAvatarConfig;
  size?: number;
  expression?: AvatarExpression;
  label?: string;
  className?: string;
  /** Replaces the config's silhouette, e.g. a lab body for `HarnessAvatar`. */
  body?: BodyGeometry;
}) {
  const { config } = props;
  const size = props.size ?? 28;
  const tiny = size <= 20;
  const paint = avatarPaint(config.color);
  const body = props.body ?? BODIES[config.shape];
  const eyes = layoutEyes(facePose(config.face, props.expression ?? "idle"), {
    radius: BODY_RADIUS,
    cx: body.faceX,
    cy: body.faceY,
    spread: body.spread,
    tiny,
    style: config.eyes,
  });
  const maskId = useId();
  const accessory = { kind: config.accessory, body, eyes, paint, tiny } as const;

  // Frame the body tightly; grow upwards only when something sits on its head.
  const minY = Math.min(
    9,
    body.top - (TOP_ACCESSORIES.has(config.accessory) ? ACCESSORY_HEADROOM : 1),
  );
  const side = 61 - minY;

  return (
    <svg
      viewBox={`${32 - side / 2} ${minY} ${side} ${side}`}
      width={size}
      height={size}
      fill="none"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      className={cn("shrink-0 select-none", props.className)}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">
          <path d={body.d} fill={MASK_KEEP} />
        </mask>
      </defs>
      <Accessory {...accessory} layer="back" />
      <path d={body.d} fill={paint.body} />
      <g mask={`url(#${maskId})`} fill={paint.eye} stroke={paint.eye} strokeWidth={0}>
        {eyes.map((eye) => (
          <Eye key={eye.side} eye={eye} style={config.eyes} />
        ))}
      </g>
      <Accessory {...accessory} layer="front" />
    </svg>
  );
}
