/**
 * signalbox: upstream's connection copy says "environment". With environments hidden there is
 * only Signalbox Cloud, so the same states read as Signalbox instead. Keyed by upstream's text:
 * if upstream rewords a string it falls back to upstream's copy rather than breaking.
 */
const ONE_ENVIRONMENT_COPY: Readonly<Record<string, string>> = {
  "Loading environments": "Loading",
  "Checking saved environments on this device.": "Getting your threads ready.",
  "Environment unavailable": "Can't reach Signalbox",
  "The saved environment is offline. Check the URL or start the environment, then retry.":
    "Check your connection. Signalbox reconnects on its own.",
  "Connecting to environment": "Connecting to Signalbox",
  "Loading projects and threads from the saved environment.": "Loading your projects and threads.",
  "Loading projects from the saved environment.": "Loading your projects.",
  "The connected environment did not report any projects.": "Add a project to get started.",
};

export function oneEnvironmentCopy(text: string): string {
  return ONE_ENVIRONMENT_COPY[text] ?? text;
}

/** An empty state with its copy reworded for the one environment. */
export function withOneEnvironmentCopy<
  T extends { readonly title: string; readonly detail: string },
>(state: T): T {
  return {
    ...state,
    title: oneEnvironmentCopy(state.title),
    detail: oneEnvironmentCopy(state.detail),
  };
}
