/**
 * The drawn desktop behind a computer's live view: OS chrome, a terminal
 * running the dev server, and a browser showing the app under test. Static
 * placeholder art until the real remote-desktop stream exists.
 */
import { useId } from "react";

import type { Computer } from "./computerModel";

const TERMINAL_LINES = [
  "$ pnpm dev",
  "  VITE v7.1 ready in 412 ms",
  "  ➜ Local: http://localhost:5173/",
  "$ pnpm test:e2e",
  "  ✓ hero renders (1.2s)",
  "  ✓ cta opens signup (0.9s)",
  "  6 passed (8.1s)",
  "$ ▍",
];

function OsChrome({ os }: { os: Computer["os"] }) {
  if (os === "windows") {
    return (
      <g>
        <rect x={0} y={952} width={1600} height={48} className="fill-background" opacity={0.92} />
        <rect x={720} y={964} width={24} height={24} rx={4} className="fill-info" />
        <rect x={760} y={964} width={24} height={24} rx={4} className="fill-muted-foreground" />
        <rect x={800} y={964} width={24} height={24} rx={4} className="fill-primary" />
        <rect x={840} y={964} width={24} height={24} rx={4} className="fill-muted-foreground" />
        <text x={1580} y={982} fontSize={15} textAnchor="end" className="fill-muted-foreground">
          14:32
        </text>
      </g>
    );
  }
  return (
    <g>
      <rect x={0} y={0} width={1600} height={34} className="fill-background" opacity={0.92} />
      <text x={20} y={22} fontSize={15} fontWeight={600} className="fill-foreground">
        {os === "macos" ? "Safari" : "Activities"}
      </text>
      {os === "macos" ? (
        <text x={90} y={22} fontSize={15} className="fill-muted-foreground">
          File Edit View History Window
        </text>
      ) : null}
      <text x={1580} y={22} fontSize={15} textAnchor="end" className="fill-muted-foreground">
        Tue 14:32
      </text>
    </g>
  );
}

function TerminalWindow() {
  return (
    <g>
      <rect
        x={48}
        y={120}
        width={640}
        height={520}
        rx={10}
        className="fill-code stroke-border"
        strokeWidth={2}
      />
      <line x1={48} x2={688} y1={158} y2={158} className="stroke-border" strokeWidth={2} />
      <text x={68} y={145} fontSize={15} className="fill-muted-foreground">
        agent@computer: ~/landing
      </text>
      {TERMINAL_LINES.map((line, index) => (
        <text
          key={line}
          x={68}
          y={196 + index * 30}
          fontSize={17}
          xmlSpace="preserve"
          className="fill-code-foreground font-mono"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function LandingPage({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <text x={x} y={y} fontSize={20} fontWeight={700} className="fill-foreground">
        Lumen
      </text>
      <text x={x + 760} y={y} fontSize={16} textAnchor="end" className="fill-muted-foreground">
        Product Pricing Docs
      </text>
      <rect
        x={x + 790}
        y={y - 22}
        width={92}
        height={32}
        rx={6}
        className="fill-background stroke-border"
        strokeWidth={2}
      />
      <text x={x + 836} y={y - 1} fontSize={15} textAnchor="middle" className="fill-foreground">
        Sign in
      </text>
      <text x={x} y={y + 110} fontSize={48} fontWeight={700} className="fill-foreground">
        Ship the landing page,
      </text>
      <text x={x} y={y + 168} fontSize={48} fontWeight={700} className="fill-foreground">
        not the meeting.
      </text>
      <text x={x} y={y + 214} fontSize={19} className="fill-muted-foreground">
        Lumen turns a product brief into a tested, deployable page in an afternoon.
      </text>
      <rect
        x={x - 4}
        y={y + 244}
        width={164}
        height={60}
        rx={11}
        fill="none"
        className="stroke-ring"
        strokeWidth={3}
        opacity={0.5}
      />
      <rect x={x} y={y + 248} width={156} height={52} rx={8} className="fill-primary" />
      <text
        x={x + 78}
        y={y + 280}
        fontSize={18}
        fontWeight={600}
        textAnchor="middle"
        className="fill-primary-foreground"
      >
        Start free
      </text>
      <rect
        x={x + 176}
        y={y + 248}
        width={168}
        height={52}
        rx={8}
        className="fill-background stroke-border"
        strokeWidth={2}
      />
      <text x={x + 260} y={y + 280} fontSize={18} textAnchor="middle" className="fill-foreground">
        See a demo
      </text>
      {["Briefs in", "Tests run", "Deploys out"].map((label, index) => {
        const tileX = x + index * 316;
        return (
          <g key={label}>
            <rect x={tileX} y={y + 370} width={296} height={150} rx={10} className="fill-muted" />
            <text x={tileX + 20} y={y + 406} fontSize={17} className="fill-foreground">
              {label}
            </text>
            <rect
              x={tileX + 20}
              y={y + 428}
              width={220}
              height={10}
              rx={5}
              className="fill-muted-foreground"
              opacity={0.25}
            />
            <rect
              x={tileX + 20}
              y={y + 450}
              width={160}
              height={10}
              rx={5}
              className="fill-muted-foreground"
              opacity={0.25}
            />
          </g>
        );
      })}
    </g>
  );
}

function BrowserWindow({ os, url }: { os: Computer["os"]; url: string }) {
  const clipId = useId();
  const [x, y, width, height] = [520, 90, 1032, 820];
  return (
    <g className="drop-shadow-xl">
      <clipPath id={clipId}>
        <rect x={x} y={y} width={width} height={height} rx={12} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x={x} y={y} width={width} height={height} className="fill-background" />
        <rect x={x} y={y} width={width} height={48} className="fill-muted" />
        {os === "macos" ? (
          <g>
            <circle cx={x + 24} cy={y + 24} r={7} className="fill-destructive" />
            <circle cx={x + 48} cy={y + 24} r={7} className="fill-warning" />
            <circle cx={x + 72} cy={y + 24} r={7} className="fill-success" />
          </g>
        ) : (
          <text
            x={x + width - 20}
            y={y + 30}
            fontSize={17}
            textAnchor="end"
            className="fill-muted-foreground"
          >
            – ▢ ✕
          </text>
        )}
        <rect x={x + 100} y={y + 8} width={240} height={40} rx={8} className="fill-background" />
        <text x={x + 120} y={y + 33} fontSize={15} className="fill-foreground">
          Lumen · Ship faster
        </text>
        <line
          x1={x}
          x2={x + width}
          y1={y + 92}
          y2={y + 92}
          className="stroke-border"
          strokeWidth={2}
        />
        <rect x={x + 20} y={y + 56} width={width - 40} height={28} rx={14} className="fill-muted" />
        <text x={x + 40} y={y + 75} fontSize={15} className="fill-muted-foreground">
          {url}
        </text>
        <LandingPage x={x + 48} y={y + 150} />
      </g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={12}
        fill="none"
        className="stroke-border"
        strokeWidth={2}
      />
    </g>
  );
}

function Cursor({ label }: { label: string }) {
  return (
    <g transform="translate(662 504)">
      <path
        d="M0 0 L0 38 L10 29 L17 45 L23 42 L16.5 27 L30 27 Z"
        className="fill-foreground stroke-background"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <rect
        x={28}
        y={40}
        width={label.length * 10 + 20}
        height={26}
        rx={6}
        className="fill-foreground"
      />
      <text x={38} y={58} fontSize={15} fontWeight={600} className="fill-background">
        {label}
      </text>
    </g>
  );
}

/** Children draw inside the scene's 1600x1000 coordinate space. */
export function MockDesktopScene({
  computer,
  cursorLabel,
}: {
  readonly computer: Computer;
  readonly cursorLabel: string | null;
}) {
  return (
    <>
      <rect width={1600} height={1000} className="fill-muted" />
      <OsChrome os={computer.os} />
      <TerminalWindow />
      <BrowserWindow os={computer.os} url={computer.browserUrl} />
      {cursorLabel ? <Cursor label={cursorLabel} /> : null}
    </>
  );
}
