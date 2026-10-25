// signalbox: upstream's environment copy, reworded where environments are hidden.
import { useCallback } from "react";

import { readShowsEnvironmentUi, useShowsEnvironmentUi } from "../../state/environmentCapabilities";
import { oneEnvironmentCopy } from "./oneEnvironmentCopy";

/** Upstream's text while environments show (T3 Code, self-hosted); Signalbox's otherwise. */
export function useOneEnvironmentCopy(): (text: string) => string {
  const showsEnvironments = useShowsEnvironmentUi();
  return useCallback(
    (text: string) => (showsEnvironments ? text : oneEnvironmentCopy(text)),
    [showsEnvironments],
  );
}

/** `useOneEnvironmentCopy` outside React: alerts and errors raised in callbacks. */
export function environmentCopy(text: string): string {
  return readShowsEnvironmentUi() ? text : oneEnvironmentCopy(text);
}
