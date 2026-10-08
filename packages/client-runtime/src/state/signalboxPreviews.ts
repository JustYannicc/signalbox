import {
  SIGNALBOX_PREVIEWS_WS_METHODS,
  type SignalboxPreviewPort,
  type SignalboxThreadPreviews,
} from "@t3tools/contracts/signalboxPreviews";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The dev servers a Signalbox Cloud thread's machine serves, and fresh links
 * to open them. Only ask environments advertising
 * `capabilities.signalboxPreviews`; others fail with
 * `SignalboxPreviewsUnavailableError`.
 */
export function createSignalboxPreviewsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Input `{ threadId }`. Empty ports while no machine runs. */
    thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-previews:thread",
      tag: SIGNALBOX_PREVIEWS_WS_METHODS.subscribe,
    }),
    /** Input `{ threadId, port }`. The link expires in minutes, so open it right away. */
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-previews:open",
      tag: SIGNALBOX_PREVIEWS_WS_METHODS.open,
    }),
  };
}

const NO_PORTS: ReadonlyArray<SignalboxPreviewPort> = [];

/**
 * The ports to offer in ascending order, so the control doesn't reshuffle.
 * The environment already lists each port once; no ports is one shared array
 * so an idle thread doesn't re-render its header.
 */
export function previewPortsToOffer(
  previews: SignalboxThreadPreviews | null,
): ReadonlyArray<SignalboxPreviewPort> {
  if (previews === null || previews.ports.length === 0) return NO_PORTS;
  return [...previews.ports].sort((a, b) => a.port - b.port);
}

/** `:5173`. The port is the preview's identity; the process name is a hint. */
export const previewPortLabel = (port: SignalboxPreviewPort) => `:${port.port}`;

/** What failed opening a preview, for a toast or alert. */
export function previewOpenFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Couldn't open the preview. Try again.";
}
