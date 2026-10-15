// signalbox: the sections panel is Home's list header, so opening it from a
// scrolled list has to bring the list back up to it.
import { useEffect, useEffectEvent, useRef } from "react";

/** Calls `scrollToTop` each time `open` turns true, not when Home mounts with it open. */
export function useRevealSectionsPanel(open: boolean, scrollToTop: () => void) {
  const wasOpen = useRef(open);
  const reveal = useEffectEvent(scrollToTop);
  useEffect(() => {
    if (open && !wasOpen.current) reveal();
    wasOpen.current = open;
  }, [open]);
}
