/**
 * signalbox: upstream's connection copy names the environment ("Signalbox Cloud is
 * reconnecting", "The environment is not connected."). Where environments are hidden there is
 * only Signalbox Cloud, so the same states read as Signalbox. Keyed by upstream's text: if
 * upstream rewords a string it falls back to upstream's copy rather than breaking. Mobile keeps
 * its own map (`apps/mobile/src/features/home/oneEnvironmentCopy.ts`).
 */
import { useCallback } from "react";

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
};

/** Phrases inside composed text. */
const ONE_ENVIRONMENT_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["Reconnect to the environment and", "Reconnect to Signalbox and"],
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
  return useCallback(
    (text: string) => (showsEnvironments ? text : oneEnvironmentCopy(text)),
    [showsEnvironments],
  );
}

/** `useOneEnvironmentCopy` outside React: toasts and thrown errors. */
export function environmentCopy(text: string): string {
  return readShowsEnvironmentUi() ? text : oneEnvironmentCopy(text);
}
