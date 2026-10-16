// @effect-diagnostics globalTimers:off globalDate:off - React and React Native hooks drive this without an Effect runtime.
/** Nobody touched the app for this long: stop watching until they're back. */
export const AGENT_BROWSER_IDLE_AFTER_MS = 5 * 60_000;

/**
 * Whether to hold the watch stream: the panel shows, the app is in front, and
 * the person did something in the last five minutes. `recheckInMs` is when the
 * answer flips on its own (the person going idle), or null if only an event can.
 */
export function agentBrowserWatchLease(input: {
  readonly panelVisible: boolean;
  readonly appVisible: boolean;
  readonly now: number;
  readonly lastActiveAt: number;
}): { readonly watching: boolean; readonly recheckInMs: number | null } {
  if (!input.panelVisible || !input.appVisible) return { watching: false, recheckInMs: null };
  const idleIn = input.lastActiveAt + AGENT_BROWSER_IDLE_AFTER_MS - input.now;
  return idleIn > 0
    ? { watching: true, recheckInMs: idleIn }
    : { watching: false, recheckInMs: null };
}

export interface AgentBrowserLease {
  /** Where the panel and the app stand now. Showing the panel counts as activity. */
  readonly update: (panelVisible: boolean, appVisible: boolean) => void;
  /** The person did something: keep watching, or start again if they'd gone idle. */
  readonly noteActivity: () => void;
  /** Stops the idle timer. A later `update` starts it again. */
  readonly dispose: () => void;
}

/**
 * The watch lease over time: tells `onChange` whether to watch on every
 * update, and again when the person goes idle. One timer for when they would
 * go idle; activity before then just moves the mark. Platforms wire their own
 * visibility and activity events to it.
 */
export function createAgentBrowserLease(options: {
  readonly onChange: (watching: boolean) => void;
}): AgentBrowserLease {
  let panelVisible = false;
  let appVisible = false;
  let lastActiveAt = 0;
  let watching = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const evaluate = () => {
    clearTimeout(timer);
    const lease = agentBrowserWatchLease({
      panelVisible,
      appVisible,
      now: Date.now(),
      lastActiveAt,
    });
    watching = lease.watching;
    options.onChange(lease.watching);
    timer = lease.recheckInMs === null ? undefined : setTimeout(evaluate, lease.recheckInMs);
  };

  return {
    update: (nextPanelVisible, nextAppVisible) => {
      if (nextPanelVisible && !panelVisible) lastActiveAt = Date.now();
      panelVisible = nextPanelVisible;
      appVisible = nextAppVisible;
      evaluate();
    },
    noteActivity: () => {
      lastActiveAt = Date.now();
      if (!watching) evaluate();
    },
    dispose: () => {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
