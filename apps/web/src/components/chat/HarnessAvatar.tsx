/**
 * One cute avatar per harness, in the assistant avatar style: a flat body
 * drawn from the lab's mark (Claude's starburst, OpenAI's six-petal knot,
 * xAI's X, Cursor's cube, OpenCode's block) in the lab's colour, with two
 * eyes. Keyed by provider, never by chat or agent, so Codex looks the same
 * everywhere. `expression` shows thinking/working.
 */
import { AssistantAvatar } from "../assistant/avatar/AssistantAvatar";
import type {
  AssistantAvatarConfig,
  AvatarColor,
  AvatarExpression,
} from "../assistant/avatar/avatarConfig";
import { LAB_BODIES, type LabShape } from "../assistant/avatar/avatarShapes";

export type HarnessAvatarSize = 16 | 20 | 28 | 32;

const LAB_LOOK: Record<string, { readonly shape: LabShape; readonly color: AvatarColor }> = {
  codex: { shape: "hexafoil", color: "ink" },
  claudeAgent: { shape: "burst", color: "orange" },
  grok: { shape: "cross", color: "grey" },
  cursor: { shape: "cube", color: "teal" },
  opencode: { shape: "block", color: "green" },
  antigravity: { shape: "hexafoil", color: "blue" },
};
const FALLBACK_LOOK = { shape: "block", color: "grey" } as const;

export function HarnessAvatar(props: {
  /** Provider driver kind, e.g. "codex" or "claudeAgent". */
  provider: string;
  size?: HarnessAvatarSize;
  /** "thinking" while the harness works. */
  expression?: AvatarExpression;
  /** Accessible name, e.g. "Codex"; decorative when omitted. */
  label?: string;
  className?: string;
}) {
  const look = LAB_LOOK[props.provider] ?? FALLBACK_LOOK;
  const config: AssistantAvatarConfig = {
    shape: "circle",
    color: look.color,
    face: "neutral",
    eyes: "round",
    accessory: "none",
  };
  return (
    <AssistantAvatar
      config={config}
      body={LAB_BODIES[look.shape]}
      size={props.size ?? 28}
      {...(props.expression ? { expression: props.expression } : {})}
      {...(props.label ? { label: props.label } : {})}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}
