/**
 * signalbox: upstream's connection copy names the environment ("Signalbox Cloud is
 * reconnecting", "The environment is not connected."). Where environments are hidden there is
 * only Signalbox Cloud, so the same states read as Signalbox. Keyed by upstream's text: if
 * upstream rewords a string it falls back to upstream's copy rather than breaking. Mobile keeps
 * its own map (`apps/mobile/src/features/home/oneEnvironmentCopy.ts`).
 */

import { readShowsEnvironmentUi, useShowsEnvironmentUi } from "./environmentCapabilities";

const ONE_ENVIRONMENT_COPY: Readonly<Record<string, string>> = {
  "Environment disconnected": "Not connected",
  "Could not reconnect environment": "Couldn't reconnect",
  "Reconnecting to the environment. Try again once it is connected.":
    "Reconnecting to Signalbox. Try again in a moment.",
  "The environment is not connected.": "Signalbox isn't connected. Try again in a moment.",
  "This environment is not connected.": "Signalbox isn't connected. Try again in a moment.",
  "Environment unavailable": "Can't reach Signalbox",
  "The selected environment is not connected.": "Signalbox isn't connected. Try again in a moment.",
  "Connect an environment to set up its providers.": "Reconnecting to Signalbox…",
  "Loading devices": "Loading providers",
  "Reading connected execution environments.": "Getting your providers ready.",
  "No connected devices": "Providers unavailable",
  "Connect an execution environment before configuring providers.":
    "Signalbox isn't connected. Try again in a moment.",
  "Connect an environment to see usage.": "Connecting to Signalbox…",
  "Connect an environment to see limits.": "Connecting to Signalbox…",
  // Features the cloud doesn't serve yet.
  "Update this server to send files with question answers":
    "Files can't be sent with question answers yet",
  "Update this environment's Signalbox server to browse pull requests.":
    "Pull requests aren't available in Signalbox yet.",
  "Update your Signalbox servers to browse pull requests.":
    "Pull requests aren't available in Signalbox yet.",
  // Access: the cloud has no pairing, so there is nothing to pair again.
  "Pair this client again with preview access to control browser previews.":
    "You don't have access to control browser previews.",
  // Connection errors (`@t3tools/client-runtime` connection, shell and authorization state).
  "The environment credential is invalid.": "Your Signalbox sign-in expired. Sign in again.",
  "The environment credential does not grant the required access.":
    "Your Signalbox sign-in doesn't allow this. Sign in again.",
  "The environment rejected the authentication request.": "Signalbox rejected the sign-in.",
  "The environment endpoint could not be found.": "Can't reach Signalbox.",
  "The environment could not authorize the connection.": "Signalbox couldn't sign you in.",
  "Could not synchronize environment data.": "Couldn't sync your threads.",
  "Your cloud sign-in changed. Sign in again to authorize the environment.":
    "Your sign-in changed. Sign in again.",
};

/** Phrases inside composed text. */
const ONE_ENVIRONMENT_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["Reconnect to the environment and", "Reconnect to Signalbox and"],
  // Provider setup: "Open provider setup to install Codex on this environment."
  [" on this environment.", "."],
  // Thread and branch actions the session's scopes don't allow.
  ["This connection cannot", "You can't"],
  ["This connection can't", "You can't"],
  // Relay sign-ins append a DPoP hint (often the device clock), so the sign-in may still be fine.
  ["The environment credential is invalid.", "Signalbox couldn't verify your sign-in."],
];

/** The cloud's environment label, which previews suffix with their PR. */
const CLOUD_ENVIRONMENT_LABEL = /Signalbox Cloud(?: \(PR #\d+\))?/g;

export function oneEnvironmentCopy(text: string): string {
  const exact = ONE_ENVIRONMENT_COPY[text];
  if (exact !== undefined) return exact;
  let reworded = text;
  for (const [from, to] of ONE_ENVIRONMENT_PHRASES) reworded = reworded.replaceAll(from, to);
  return reworded.replace(CLOUD_ENVIRONMENT_LABEL, "Signalbox");
}

/** Upstream's text while environments show (T3 Code, self-hosted); Signalbox's otherwise. */
export function useOneEnvironmentCopy(): (text: string) => string {
  const showsEnvironments = useShowsEnvironmentUi();
  return (text: string) => (showsEnvironments ? text : oneEnvironmentCopy(text));
}

/** `useOneEnvironmentCopy` outside React: toasts and thrown errors. */
export function environmentCopy(text: string): string {
  return readShowsEnvironmentUi() ? text : oneEnvironmentCopy(text);
}
