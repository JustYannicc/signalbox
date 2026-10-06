/**
 * The send lock drawn as a padlock: the round send button is the lock body
 * and a shackle sits on top of it. Clicking the shackle latches it down onto
 * the button (sending locked; Enter adds a line) or lifts it (unlocked). While
 * unlocked the shackle stays faint until the send area is hovered or focused.
 *
 * Holding Shift alone inside the composer previews the latch: Shift+Enter adds
 * a line instead of sending, so the lock shows it. The preview waits a beat and
 * any other key cancels it, so typing capitals doesn't flicker the shackle. It
 * is display-only and never persisted; it lives in this component and reaches
 * the arrow through context, so the composer never re-renders for it.
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { ComposerSendLock } from "./composerSendLock";

// Left leg, arc, right leg. Open: the right leg stops short of the body.
const CLOSED_SHACKLE = "M4.5 15V7.5a5.5 5.5 0 0 1 11 0V15";
const OPEN_SHACKLE = "M4.5 15V7.5a5.5 5.5 0 0 1 11 0V10";

/** True while the send arrow inside a latch should show the strike-through. */
const SendArrowStruckContext = createContext(false);

const SHIFT_PREVIEW_DELAY_MS = 200;

/** Tracks Shift held alone while focus is inside the composer form around `anchor`. */
function useShiftHeldInComposer(anchor: RefObject<HTMLElement | null>): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>("[data-chat-composer-form]");
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      clearTimeout(timer);
      setHeld(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const shiftAlone = event.key === "Shift" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!shiftAlone) return release();
      if (event.repeat) return;
      clearTimeout(timer);
      timer = setTimeout(() => setHeld(true), SHIFT_PREVIEW_DELAY_MS);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") release();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) release();
    };
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("keyup", onKeyUp);
    root.addEventListener("focusout", onFocusOut);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      release();
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("keyup", onKeyUp);
      root.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [anchor]);
  return held;
}

/** Wraps the send button in the padlock. Without a `lock` it renders the button alone. */
export function SendLockLatch(props: { lock: ComposerSendLock | undefined; children: ReactNode }) {
  if (!props.lock) return props.children;
  return <Latch lock={props.lock}>{props.children}</Latch>;
}

function Latch(props: { lock: ComposerSendLock; children: ReactNode }) {
  const { on, locked, toggle } = props.lock;
  const anchorRef = useRef<HTMLSpanElement>(null);
  const shiftHeld = useShiftHeldInComposer(anchorRef);
  const latched = on || shiftHeld;

  return (
    <span ref={anchorRef} className="group/send-lock relative inline-flex shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-pressed={on}
              aria-label={on ? "Unlock sending" : "Lock sending"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={toggle}
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
          {on ? "Unlock sending" : "Lock sending · Enter adds a line until you unlock"}
        </TooltipPopup>
      </Tooltip>
      <SendArrowStruckContext value={locked || shiftHeld}>{props.children}</SendArrowStruckContext>
    </span>
  );
}

/** Goes inside the send arrow's 14×14 svg: a diagonal strike while the latch holds. */
export function SendArrowLockStrike() {
  const struck = use(SendArrowStruckContext);
  if (!struck) return null;
  return (
    <path d="M2.5 11.5L11.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  );
}
