/**
 * The frame a visible computer's desktop streams into, plus the paused and
 * released overlays. The stream itself is a placeholder scene for now.
 */
import type { Ref } from "react";

import type { Computer } from "./computerModel";
import { MockDesktopScene } from "./MockDesktopScene";

export function ComputerLiveView({
  computer,
  controlledByUser,
  ref,
}: {
  readonly computer: Computer;
  readonly controlledByUser: boolean;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  const live = computer.state === "live";
  return (
    <div
      ref={ref}
      className="relative w-full overflow-hidden rounded-lg border border-border bg-muted"
    >
      <svg
        viewBox="0 0 1600 1000"
        role="img"
        aria-label={`Live view of ${computer.name}: a browser testing the app at ${computer.browserUrl}`}
        className="block h-auto w-full"
      >
        <MockDesktopScene
          computer={computer}
          cursorLabel={live ? (controlledByUser ? "You" : "Agent") : null}
        />
      </svg>
      {live ? null : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/85 p-6 text-center">
          <span className="text-sm font-medium text-foreground">
            {computer.state === "paused" ? "Paused. Billing stopped." : "Released."}
          </span>
          <span className="max-w-sm text-xs text-muted-foreground">
            {computer.state === "paused"
              ? "The disk is kept, so resuming picks up exactly here. This is the last frame."
              : `The computer is gone. ${computer.artifacts.length} artifacts were kept in the durable workspace.`}
          </span>
        </div>
      )}
    </div>
  );
}
