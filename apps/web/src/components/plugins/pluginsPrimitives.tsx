/**
 * Small pieces shared by every Plugins section: the integration mark, auth
 * state, and the per-harness availability toggles.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HARNESSES, type AuthState, type HarnessId } from "./pluginsModel";

/**
 * For rows a search result can deep-link to (`?item=`): scrolls the row into
 * view once when it becomes the target. Pair with `DEEP_LINK_ROW_CLASS`.
 */
export function useDeepLinkRow<T extends HTMLElement>(targeted: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (targeted) ref.current?.scrollIntoView({ block: "center" });
  }, [targeted]);
  return ref;
}

export const DEEP_LINK_ROW_CLASS = "bg-accent/40";

/** Prototype stand-in for every action that would need a backend. */
export function comingSoon(action: string) {
  toastManager.add({ title: `${action}: coming soon`, timeout: 2000 });
}

/** A monochrome letter mark; brand logos stay out until we ship real assets. */
export function IntegrationMark(props: { glyph: string; size?: "sm" | "md" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted font-semibold tracking-tight text-muted-foreground",
        props.size === "sm" ? "size-5 text-3xs" : "size-7 text-xs",
      )}
    >
      {props.glyph}
    </span>
  );
}

const AUTH_PRESENTATION: Record<
  AuthState,
  { label: string; dot: string; variant: "success" | "warning" | "error" | "outline" }
> = {
  connected: { label: "Connected", dot: "bg-success", variant: "success" },
  "needs-reauth": { label: "Needs re-auth", dot: "bg-warning", variant: "warning" },
  error: { label: "Error", dot: "bg-error", variant: "error" },
  none: { label: "No auth", dot: "bg-muted-foreground/40", variant: "outline" },
};

export function StatusDot(props: { auth: AuthState }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", AUTH_PRESENTATION[props.auth].dot)}
    />
  );
}

export function AuthStateBadge(props: { auth: AuthState }) {
  const presentation = AUTH_PRESENTATION[props.auth];
  return (
    <Badge variant={presentation.variant} size="sm">
      {presentation.label}
    </Badge>
  );
}

/** Harness enablement per item, local to the page until there is something to save to. */
export function useHarnessSelection(
  items: readonly { readonly id: string; readonly harnesses: readonly HarnessId[] }[],
) {
  const [selection, setSelection] = useState<Record<string, readonly HarnessId[]>>(() =>
    Object.fromEntries(items.map((item) => [item.id, item.harnesses])),
  );
  // `fallback` covers items added after the page opened (none of their harnesses toggled yet).
  const toggle = useCallback(
    (id: string, harness: HarnessId, fallback: readonly HarnessId[] = []) => {
      setSelection((current) => {
        const enabled = current[id] ?? fallback;
        return {
          ...current,
          [id]: enabled.includes(harness)
            ? enabled.filter((entry) => entry !== harness)
            : [...enabled, harness],
        };
      });
    },
    [],
  );
  return [selection, toggle] as const;
}

export function HarnessToggles(props: {
  itemName: string;
  enabled: readonly HarnessId[];
  onToggle: (harness: HarnessId) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={`Harnesses for ${props.itemName}`}
      className={cn("flex shrink-0 items-center gap-0.5", props.className)}
    >
      {HARNESSES.map((harness) => {
        const on = props.enabled.includes(harness.id);
        const HarnessIcon = harness.icon;
        return (
          <Tooltip key={harness.id}>
            <TooltipTrigger
              render={
                <Toggle
                  size="xs"
                  variant="ghost"
                  pressed={on}
                  onPressedChange={() => props.onToggle(harness.id)}
                  aria-label={`${harness.label} for ${props.itemName}`}
                />
              }
            >
              {HarnessIcon ? (
                <HarnessIcon className={cn("size-3.5", on ? "opacity-100" : "opacity-25")} />
              ) : (
                <span className="text-3xs font-semibold">{harness.label.slice(0, 2)}</span>
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {harness.label}: {on ? "on" : "off"}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function HarnessGlyph(props: { harness: HarnessId }) {
  const HarnessIcon = HARNESSES.find((entry) => entry.id === props.harness)?.icon;
  return HarnessIcon ? <HarnessIcon aria-hidden className="size-4 shrink-0" /> : null;
}

export function HarnessIconLabel(props: { harness: HarnessId }) {
  const harness = HARNESSES.find((entry) => entry.id === props.harness);
  if (!harness) return null;
  return (
    <span className="flex items-center gap-2">
      <HarnessGlyph harness={harness.id} />
      {harness.label}
    </span>
  );
}
