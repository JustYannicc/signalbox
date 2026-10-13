/**
 * The shared Pipeline status marker for a run, a step, or an automation.
 * Renders nothing for a passing run: there is nothing to see.
 */
import { StatusMarker } from "../sidebar/sections/StatusMarkers";
import type { ThreadDisplayStatus } from "../threadStatusDisplay";

export function RunStatusMarker(props: { status: ThreadDisplayStatus | null }) {
  return props.status ? <StatusMarker status={props.status} /> : null;
}
