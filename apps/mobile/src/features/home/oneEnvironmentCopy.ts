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
  // Pull requests: Signalbox Cloud doesn't serve the pull-request list.
  "Environment offline": "Can't reach Signalbox",
  "Connect an environment": "No pull requests",
  "Add an environment in Settings to browse its pull requests.":
    "Pull requests aren't available in Signalbox yet.",
  "Pull requests from the selected environments' projects appear here.":
    "Pull requests from your projects appear here.",
  // Activity updates.
  "Agent activity updates are enabled for environments this connection can configure.":
    "Agent activity updates are enabled.",
  "Agent activity updates are enabled. Add an environment to start receiving updates.":
    "Agent activity updates are enabled.",
  // Scheduled tasks and automations run on self-hosted servers only.
  "Connect an environment to view and create scheduled tasks.":
    "Scheduled tasks aren't available in Signalbox yet.",
  "Connect an environment to create a scheduled task.":
    "Scheduled tasks aren't available in Signalbox yet.",
  "Connect an environment to see its automations.":
    "Automations aren't available in Signalbox yet.",
  // Client storage.
  "This removes offline threads, server metadata, and cached branches for this environment. The saved connection and credentials stay intact.":
    "This removes offline threads, server metadata, and cached branches from this device. Your account and your threads in Signalbox stay intact.",
  "This removes offline data for every environment. Connections, credentials, account data, and app preferences stay intact.":
    "This removes all offline data from this device. Your account, your threads in Signalbox, and app preferences stay intact.",
  "Offline cache records will appear here after environments are used.":
    "Offline cache records will appear here once you use Signalbox on this device.",
  "Clearing caches never removes environment connections, credentials, account data, or appearance preferences.":
    "Clearing caches never removes your account, your threads in Signalbox, or appearance preferences.",
  // Filters.
  "Try another search or environment.": "Try another search.",
  "Filter settings environments and projects": "Filter settings projects",
};

/**
 * Phrases inside templated or composed text: connection notices name what's loading, and
 * relay errors append their cause. Replaced wherever they appear.
 */
const ONE_ENVIRONMENT_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["as soon as the environment is ready", "as soon as Signalbox is ready"],
  ["Reconnect the environment to", "Reconnect to Signalbox to"],
  ["Reconnect this environment to", "Reconnect to Signalbox to"],
  ["unavailable on this environment", "unavailable in Signalbox"],
  // Enabling activity updates links each environment to the relay (`cloud/linkEnvironment.ts`).
  [
    "Relay returned credentials for a different environment",
    "Relay returned credentials for a different server",
  ],
  ["Could not obtain environment link proof", "Could not verify Signalbox for activity updates"],
  ["Could not configure environment relay access", "Could not set up activity updates"],
];

export function oneEnvironmentCopy(text: string): string {
  const exact = ONE_ENVIRONMENT_COPY[text];
  if (exact !== undefined) return exact;
  let reworded = text;
  for (const [from, to] of ONE_ENVIRONMENT_PHRASES) reworded = reworded.replaceAll(from, to);
  return reworded;
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
