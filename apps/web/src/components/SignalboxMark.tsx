import type { ComponentProps, SVGProps } from "react";

import { cn } from "~/lib/utils";

/**
 * The Signalbox mark: the box, with one semaphore arm raised "at clear" from
 * its lower-left pivot. Drawn in currentColor so themes and the stage
 * backdrop recolor it. Keep in sync with the app icon source,
 * assets/{dev,nightly,prod}/app-icon.icon/Assets/text.svg (128pt grid).
 */
export function SignalboxMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="5.5" strokeWidth="2.25" />
      <path d="M7.75 16.25 15 9" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Mark plus the lowercase wordmark. The mark sizes from the font size, so set
 * `text-*` on it (or a parent) rather than sizing the mark directly.
 */
export function SignalboxLogo({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-semibold tracking-tight", className)}
      {...props}
    >
      <SignalboxMark aria-hidden className="size-[1.15em] shrink-0" />
      {/* Center the x-height on the mark; descenders hang free. */}
      <span className="whitespace-nowrap [text-box:trim-both_ex_alphabetic]">signalbox</span>
    </span>
  );
}
