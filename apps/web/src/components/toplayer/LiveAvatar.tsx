/**
 * The assistant's avatar, alive: it reacts to what's going on instead of
 * sitting still. Anything can call `reactAvatar("hop", "happy")`; the avatar
 * plays that move once and wears the expression for a moment. Between
 * reactions it fidgets now and then (a glance, a little hop) on a timer, never
 * a looping animation, so an idle screen costs nothing. Poking it makes it hop.
 * Reduced motion keeps the expressions and drops the moves.
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { AssistantAvatar, useAssistantAvatar, type AvatarExpression } from "../assistant/avatar";
import { ActivityProp, type AvatarActivity } from "./ActivityProp";

export type AvatarMove = "hop" | "celebrate" | "nod" | "wiggle";

interface AvatarMood {
  /** Wins over the caller's base expression until it times out. */
  override: AvatarExpression | null;
  move: { readonly kind: AvatarMove; readonly seq: number } | null;
}

const useAvatarMood = create<AvatarMood>()(() => ({ override: null, move: null }));
let overrideTimer: number | undefined;

/** Play `move` once and wear `expression` for `ms`. */
export function reactAvatar(move: AvatarMove | null, expression?: AvatarExpression, ms = 1400) {
  const previous = useAvatarMood.getState().move;
  useAvatarMood.setState({
    ...(move ? { move: { kind: move, seq: (previous?.seq ?? 0) + 1 } } : {}),
    ...(expression ? { override: expression } : {}),
  });
  if (expression) {
    window.clearTimeout(overrideTimer);
    overrideTimer = window.setTimeout(() => useAvatarMood.setState({ override: null }), ms);
  }
}

// The keyframes carry the squash and stretch; the curve only decelerates.
const SPRING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Body keyframes and the matching shadow squash, as fractions of the avatar's height. */
function moveFrames(kind: AvatarMove, size: number) {
  const up = -size * 0.22;
  switch (kind) {
    case "hop":
      return {
        body: [
          { transform: "none" },
          { transform: "translateY(0) scale(1.08, 0.92)", offset: 0.14 },
          { transform: `translateY(${up}px) scale(0.95, 1.06)`, offset: 0.45 },
          { transform: "translateY(0) scale(1.07, 0.93)", offset: 0.8 },
          { transform: "none" },
        ],
        shadow: [
          { transform: "none", opacity: 1 },
          { transform: "scale(0.6)", opacity: 0.5, offset: 0.45 },
          { transform: "none", opacity: 1 },
        ],
        duration: 620,
      };
    case "celebrate":
      return {
        body: [
          { transform: "none" },
          { transform: `translateY(${up}px) rotate(-10deg)`, offset: 0.22 },
          { transform: "translateY(0) scale(1.06, 0.94)", offset: 0.42 },
          { transform: `translateY(${up * 1.3}px) rotate(12deg)`, offset: 0.66 },
          { transform: "translateY(0) scale(1.06, 0.94)", offset: 0.88 },
          { transform: "none" },
        ],
        shadow: [
          { transform: "none", opacity: 1 },
          { transform: "scale(0.65)", opacity: 0.5, offset: 0.22 },
          { transform: "none", opacity: 1, offset: 0.42 },
          { transform: "scale(0.55)", opacity: 0.45, offset: 0.66 },
          { transform: "none", opacity: 1 },
        ],
        duration: 1050,
      };
    case "nod":
      return {
        body: [
          { transform: "none" },
          { transform: `translateY(${size * 0.05}px) rotate(3deg)`, offset: 0.3 },
          { transform: "none", offset: 0.55 },
          { transform: `translateY(${size * 0.04}px) rotate(2deg)`, offset: 0.78 },
          { transform: "none" },
        ],
        shadow: [{ transform: "none" }, { transform: "scale(1.05)" }, { transform: "none" }],
        duration: 560,
      };
    case "wiggle":
      return {
        body: [
          { transform: "none" },
          { transform: "rotate(-9deg)", offset: 0.25 },
          { transform: "rotate(8deg)", offset: 0.55 },
          { transform: "rotate(-4deg)", offset: 0.8 },
          { transform: "none" },
        ],
        shadow: [{ transform: "none" }, { transform: "none" }],
        duration: 520,
      };
  }
}

const IDLE_MOVES: ReadonlyArray<[AvatarMove | null, AvatarExpression]> = [
  [null, "thinking"],
  ["hop", "happy"],
  ["wiggle", "idle"],
  [null, "listening"],
];

export function LiveAvatar(props: {
  size: number;
  /** What it looks like when nothing is happening, e.g. "listening" while you type. */
  expression?: AvatarExpression;
  /** Fidget on its own every so often. */
  idle?: boolean;
  /** Hop hello on arrival. */
  greet?: boolean;
  /** Acts out what the agents are doing: a prop in its hands, or z's when all is quiet. */
  activity?: AvatarActivity | undefined;
  /** Pairs this avatar with another page's for a view transition. */
  viewTransitionName?: string;
}) {
  const [config] = useAssistantAvatar();
  const { override, move } = useAvatarMood();
  const bodyRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const expression = override ?? props.expression ?? "idle";
  const tilted = expression === "listening" && !override;

  useEffect(() => {
    const body = bodyRef.current;
    const shadow = shadowRef.current;
    if (!move || !body || !shadow) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const frames = moveFrames(move.kind, props.size);
    const timing = { duration: frames.duration, easing: SPRING };
    const animations = [body.animate(frames.body, timing), shadow.animate(frames.shadow, timing)];
    return () => animations.forEach((animation) => animation.cancel());
  }, [move, props.size]);

  useEffect(() => {
    if (props.greet) reactAvatar("hop", "happy", 1200);
  }, [props.greet]);

  useEffect(() => {
    if (!props.idle) return;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (document.visibilityState === "visible" && !useAvatarMood.getState().override) {
            const [idleMove, idleExpression] =
              IDLE_MOVES[Math.floor(Math.random() * IDLE_MOVES.length)] ?? IDLE_MOVES[0]!;
            reactAvatar(idleMove, idleExpression, 1300);
          }
          schedule();
        },
        7000 + Math.random() * 7000,
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [props.idle]);

  return (
    <button
      type="button"
      aria-label="Poke your assistant"
      onClick={() => reactAvatar(Math.random() < 0.5 ? "hop" : "wiggle", "happy", 1100)}
      className="relative flex shrink-0 cursor-pointer flex-col items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      style={{
        width: props.size,
        height: props.size * 1.12,
        ...(props.viewTransitionName ? { viewTransitionName: props.viewTransitionName } : {}),
      }}
    >
      <div
        ref={bodyRef}
        className="origin-bottom transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ transform: tilted ? "rotate(-7deg) translateX(-3%)" : undefined }}
      >
        <div className="relative">
          <AssistantAvatar
            // Resting closes its eyes; everything else keeps the face you picked.
            config={
              props.activity === "resting" && !override ? { ...config, face: "sleepy" } : config
            }
            size={props.size}
            expression={expression}
          />
          {props.activity && props.size >= 40 ? (
            <ActivityProp key={props.activity} activity={props.activity} />
          ) : null}
        </div>
      </div>
      <div
        ref={shadowRef}
        aria-hidden
        className="absolute bottom-0 h-2 w-1/2 rounded-full bg-foreground/10 blur-xs"
      />
    </button>
  );
}
