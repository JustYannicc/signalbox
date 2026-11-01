import { readRpcData } from "../../../../src/rpc/Resources.ts";
import { createClaudeToolObservation } from "../../../../src/harness/ClaudeToolObservation.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import type { FacetState } from "./facetState.ts";
import type { ClaudeVariant } from "./claudeCTransport.ts";
import { jsonBytes } from "./common.ts";

/** Only hooks installs SDK callbacks; the normal public selector must keep baseline unhooked. */
export function claudeQualificationToolObservation(input: {
  readonly variant: ClaudeVariant;
  readonly incarnation: string;
  readonly capability: Pick<QualifierCapabilities, "artifact" | "append">;
  readonly state: Pick<FacetState, "queue">;
}) {
  if (input.variant === "baseline") return undefined;
  return createClaudeToolObservation(({ input: event, toolUseId }) => {
    const captured = (async () => {
      const artifact = await readRpcData(
        input.capability.artifact(
          `claude-hook-${input.incarnation}-${event.hook_event_name}-${toolUseId ?? "unknown"}`,
          jsonBytes(event),
        ),
      );
      await readRpcData(
        input.capability.append("claude-sdk-tool-observed", {
          variant: input.variant,
          incarnation: input.incarnation,
          event: event.hook_event_name,
          toolUseId,
          artifact,
        }),
      );
    })();
    // The SDK keeps tool decisions unchanged; a failed capture still fails checkpoint export.
    input.state.queue(() => captured);
    return captured;
  });
}
