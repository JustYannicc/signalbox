// signalbox: upstream's environment copy, reworded where environments are hidden.
import { useCallback } from "react";

import { useShowsEnvironmentUi } from "../../state/environmentCapabilities";
import { oneEnvironmentCopy } from "./oneEnvironmentCopy";

/** Upstream's text while environments show (T3 Code, self-hosted); Signalbox's otherwise. */
export function useOneEnvironmentCopy(): (text: string) => string {
  const showsEnvironments = useShowsEnvironmentUi();
  return useCallback(
    (text: string) => (showsEnvironments ? text : oneEnvironmentCopy(text)),
    [showsEnvironments],
  );
}
