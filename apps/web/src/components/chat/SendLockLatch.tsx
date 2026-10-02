/**
 * The send lock drawn as a padlock: the round send button is the lock body
 * and a shackle sits on top of it. Clicking the shackle latches it down onto
 * the button (sending locked; Enter adds a line) or lifts it (unlocked). While
 * unlocked the shackle stays faint until the send area is hovered or focused.
 *
 * Holding Shift (no other modifier) inside the composer previews the latch:
 * Shift+Enter adds a line instead of sending, so the lock shows it. The
 * preview is display-only and never persisted; it lives in this component and
 * reaches the arrow through context, so the composer never re-renders for it.
 */
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Left leg, arc, right leg. Open: the right leg stops short of the body.
const CLOSED_SHACKLE = "M4.5 15V7.5a5.5 5.5 0 0 1 11 0V15";
const OPEN_SHACKLE = "M4.5 15V7.5a5.5 5.5 0 0 1 11 0V10";

/** True while Shift previews the latch on the enclosing send button. */
const ShiftPreviewContext = createContext(false);

function isShiftOnly(event: KeyboardEvent): boolean {
  return event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Tracks Shift held while focus is inside the composer form around `anchor`. */
function useShiftHeldInComposer(anchor: RefObject<HTMLElement | null>): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const root =
      anchor.current?.closest<HTMLElement>("[data-chat-composer-form]") ??
      anchor.current?.closest("form") ??
      null;
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      setHeld(isShiftOnly(event));
    };
    const release = () => {
      setHeld(false);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) setHeld(false);
    };
    root.addEventListener("keydown", onKey);
    root.addEventListener("keyup", onKey);
    root.addEventListener("focusout", onFocusOut);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("keyup", onKey);
      root.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [anchor]);
  return held;
}

export function SendLockLatch(props: {
  locked: boolean;
  onToggle: () => void;
  /** The send button: the lock body. */
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const shiftHeld = useShiftHeldInComposer(anchorRef);
  const latched = props.locked || shiftHeld;

  return (
    <span ref={anchorRef} className="group/send-lock relative inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-pressed={props.locked}
              aria-label={props.locked ? "Unlock sending" : "Lock sending"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onToggle}
              className={cn(
                "absolute bottom-full left-1/2 -mb-1.5 flex h-4 w-5 -translate-x-1/2 cursor-pointer items-end justify-center rounded-t-full outline-hidden ring-ring focus-visible:ring-2",
                latched
                  ? "text-foreground"
                  : "text-muted-foreground opacity-40 group-hover/send-lock:opacity-100 group-focus-within/send-lock:opacity-100 hover:text-foreground",
              )}
            />
          }
        >
          <svg
            width="20"
            height="16"
            viewBox="0 0 20 16"
            fill="none"
            aria-hidden="true"
            className={cn(
              "transition-transform duration-150",
              latched ? "translate-y-0" : "-translate-y-1",
            )}
          >
            <path
              d={latched ? CLOSED_SHACKLE : OPEN_SHACKLE}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </TooltipTrigger>
        <TooltipPopup>
          {props.locked ? "Unlock sending" : "Lock sending · Enter adds a line until you unlock"}
        </TooltipPopup>
      </Tooltip>
      <ShiftPreviewContext value={shiftHeld}>{props.children}</ShiftPreviewContext>
    </span>
  );
}

/** The send arrow; locked (or Shift held, inside a latch) adds a diagonal strike-through. */
export function SendArrowIcon(props: { locked: boolean }) {
  const shiftHeld = use(ShiftPreviewContext);
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {props.locked || shiftHeld ? (
        <path
          d="M2.5 11.5L11.5 2.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}
