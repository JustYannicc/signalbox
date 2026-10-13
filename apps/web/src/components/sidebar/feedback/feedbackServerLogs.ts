/**
 * Recent server warnings and errors for the feedback button's "Attach server
 * logs" option. Reads the primary environment's trace diagnostics (the same
 * data as Settings → Diagnostics) at send time, so nothing is buffered in the
 * client and nothing leaves the server unless the user sends feedback.
 */
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { ServerTraceDiagnosticsResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { serverEnvironment } from "../../../state/server";

const READ_TIMEOUT_MS = 10_000;

function formatServerLogs(result: ServerTraceDiagnosticsResult): string {
  const lines = result.latestWarningAndErrorLogs.map(
    (log) =>
      `${DateTime.formatIso(log.seenAt)} [${log.level}] ${log.spanName}: ${log.message} (trace ${log.traceId})`,
  );
  // The read succeeds even when the trace file is missing or unreadable.
  const error = Option.getOrNull(result.error);
  if (error) {
    const partial = Option.getOrElse(result.partialFailure, () => false);
    lines.unshift(`${partial ? "Logs may be incomplete" : "Trace unreadable"}: ${error.message}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No server warnings or errors in the trace.";
}

/** Never rejects: a failed read becomes the attachment's text, so feedback still sends. */
export async function readFeedbackServerLogs(): Promise<string> {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return "Server logs unavailable: no primary environment.";

  const result = await executeAtomQuery(
    appAtomRegistry,
    serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
    {
      refresh: true,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      reportDefect: false,
      reportFailure: false,
    },
  );
  return result._tag === "Success"
    ? formatServerLogs(result.value)
    : "Server logs unavailable: the diagnostics read failed or timed out.";
}
