/**
 * The thing the avatar is holding, so it acts out what the agents are doing:
 * a laptop while one codes, a book while one reads, a notepad while one
 * writes, a phone while one books. Resting gets drifting z's; waiting on you
 * gets a little "!" bubble. Drawn over the avatar's lower body in a 100×100
 * box. Each prop moves in short bursts on a timer, never a looping animation.
 */
import { useEffect, useEffectEvent, useRef } from "react";

import type { AgentActivity } from "./topLayerFixtures";

export type AvatarActivity = AgentActivity | "resting" | "waiting";

const PAPER = "fill-card stroke-foreground/45";
const INK = "stroke-foreground/35";

/** Calls `play` every `min`–`max` ms while the tab is visible, unless motion is reduced. */
function useBursts(play: () => void, min: number, max: number) {
  const onBurst = useEffectEvent(play);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (document.visibilityState === "visible") onBurst();
          schedule();
        },
        min + Math.random() * (max - min),
      );
    };
    const first = window.setTimeout(() => onBurst(), 500);
    schedule();
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(first);
    };
  }, [min, max]);
}

function animate(element: Element | null, frames: Keyframe[], duration: number) {
  element?.animate(frames, { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}

function Laptop() {
  const ref = useRef<SVGGElement>(null);
  useBursts(
    () =>
      animate(
        ref.current,
        [
          { transform: "none" },
          { transform: "translateY(1.5px)" },
          { transform: "none" },
          { transform: "translateY(1.2px)" },
          { transform: "none" },
          { transform: "translateY(1.5px)" },
          { transform: "none" },
        ],
        520,
      ),
    1400,
    2600,
  );
  return (
    <g ref={ref} strokeWidth={2.2} strokeLinejoin="round">
      <rect x={24} y={60} width={52} height={30} rx={4} className={PAPER} />
      <circle cx={50} cy={75} r={3} className="fill-foreground/25" />
      <rect x={15} y={89} width={70} height={7} rx={3} className={PAPER} />
    </g>
  );
}

function Book() {
  const page = useRef<SVGPathElement>(null);
  useBursts(
    () =>
      animate(
        page.current,
        [
          { transform: "scaleX(1)", opacity: 1 },
          { transform: "scaleX(0.05)", opacity: 1, offset: 0.5 },
          { transform: "scaleX(-1)", opacity: 0.9, offset: 0.98 },
          { transform: "scaleX(-1)", opacity: 0 },
        ],
        760,
      ),
    3200,
    5200,
  );
  const right = "M50 66 Q63 61 79 64 L79 93 Q63 90 50 95 Z";
  return (
    <g strokeWidth={2.2} strokeLinejoin="round">
      <path d="M50 66 Q37 61 21 64 L21 93 Q37 90 50 95 Z" className={PAPER} />
      <path d={right} className={PAPER} />
      <g className={INK} strokeWidth={1.6} strokeLinecap="round">
        <path d="M27 71 L44 72 M27 77 L44 78 M27 83 L40 84 M56 72 L73 71 M56 78 L73 77" />
      </g>
      <path
        ref={page}
        d={right}
        className={PAPER}
        opacity={0}
        style={{ transformBox: "view-box", transformOrigin: "50px 80px" }}
      />
    </g>
  );
}

function Notepad() {
  const pencil = useRef<SVGGElement>(null);
  useBursts(
    () =>
      animate(
        pencil.current,
        [
          { transform: "none" },
          { transform: "translate(-3px, 1px) rotate(-4deg)" },
          { transform: "translate(1px, 0) rotate(2deg)" },
          { transform: "translate(-4px, 2px) rotate(-5deg)" },
          { transform: "none" },
        ],
        680,
      ),
    1600,
    3000,
  );
  return (
    <g strokeWidth={2.2} strokeLinejoin="round">
      <rect x={28} y={62} width={36} height={33} rx={3} className={PAPER} />
      <path
        d="M34 71 L58 71 M34 78 L58 78 M34 85 L50 85"
        className={INK}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <g ref={pencil} style={{ transformBox: "fill-box", transformOrigin: "0% 100%" }}>
        <path
          d="M58 86 L77 62"
          className="stroke-foreground/60"
          strokeWidth={4}
          strokeLinecap="round"
        />
      </g>
    </g>
  );
}

function Phone() {
  const tap = useRef<SVGCircleElement>(null);
  useBursts(
    () =>
      animate(
        tap.current,
        [
          { transform: "scale(0.4)", opacity: 0.9 },
          { transform: "scale(1.6)", opacity: 0 },
        ],
        700,
      ),
    2200,
    3800,
  );
  return (
    <g strokeWidth={2.2} strokeLinejoin="round">
      <rect x={38} y={58} width={24} height={38} rx={5} className={PAPER} />
      <rect x={42} y={64} width={16} height={22} rx={2} className="fill-foreground/10" />
      <circle
        ref={tap}
        cx={50}
        cy={75}
        r={4}
        className="fill-foreground/30"
        opacity={0}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      />
    </g>
  );
}

function Zs() {
  const ref = useRef<SVGGElement>(null);
  useBursts(
    () =>
      animate(
        ref.current,
        [
          { transform: "translate(0, 6px)", opacity: 0 },
          { transform: "translate(2px, 0)", opacity: 1, offset: 0.3 },
          { transform: "translate(6px, -10px)", opacity: 0 },
        ],
        2200,
      ),
    2600,
    4200,
  );
  return (
    <g ref={ref} opacity={0} className="fill-muted-foreground" fontWeight={700}>
      <text x={74} y={30} fontSize={13}>
        z
      </text>
      <text x={83} y={20} fontSize={10}>
        z
      </text>
    </g>
  );
}

function Bubble() {
  const ref = useRef<SVGGElement>(null);
  useBursts(
    () =>
      animate(
        ref.current,
        [{ transform: "scale(1)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }],
        420,
      ),
    3000,
    5000,
  );
  return (
    <g ref={ref} style={{ transformBox: "fill-box", transformOrigin: "0% 100%" }} strokeWidth={2}>
      <path
        d="M76 10 h16 a5 5 0 0 1 5 5 v10 a5 5 0 0 1 -5 5 h-9 l-6 5 v-5 h-1 a5 5 0 0 1 -5 -5 v-10 a5 5 0 0 1 5 -5 z"
        className={PAPER}
      />
      <path
        d="M84 15 L84 22"
        className="stroke-foreground/70"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <circle cx={84} cy={26.5} r={1.6} className="fill-foreground/70" />
    </g>
  );
}

export function ActivityProp(props: { activity: AvatarActivity }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
      aria-hidden
    >
      {props.activity === "coding" ? <Laptop /> : null}
      {props.activity === "reading" ? <Book /> : null}
      {props.activity === "writing" ? <Notepad /> : null}
      {props.activity === "booking" ? <Phone /> : null}
      {props.activity === "resting" ? <Zs /> : null}
      {props.activity === "waiting" ? <Bubble /> : null}
    </svg>
  );
}
