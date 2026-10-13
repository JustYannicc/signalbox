/**
 * A service's own mark in its brand color, e.g. `<BrandMark brand="slack" className="size-3" />`.
 * Decorative: put it next to a label or inside a labelled tile. Size it with
 * `className`; color comes from the brand (see `brandMarks.ts` for dark mode).
 */
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { BRAND_MARKS, type BrandId } from "./brandMarks";

export function BrandMark(props: { brand: BrandId; className?: string }) {
  const mark = BRAND_MARKS[props.brand];
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn(
        "shrink-0 text-(color:--brand-mark)",
        mark.inheritOnDark && "dark:text-inherit",
        props.className,
      )}
      style={{ "--brand-mark": mark.hex } as CSSProperties}
    >
      <path d={mark.path} />
    </svg>
  );
}
