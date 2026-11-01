import { readRpcData } from "../../../../src/rpc/Resources.ts";
import { restoreFacetCheckpoint } from "./checkpointLineage.ts";
import type { CheckpointLineage } from "./checkpointLineage.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { RunnerTurn, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { HarnessRequestFacetError } from "../../../../src/harness/HarnessRequestFacet.ts";
import { encodeHarnessCProductNativeCheckpoint } from "../../../../src/harness/HarnessCProductCheckpoint.ts";
import type { HarnessCProductTurnBindings } from "../../../../src/harness/HarnessCProductFacet.ts";
import type { HarnessCheckpoint } from "../../../../src/harness/Harness.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { retainedFacetState } from "./facetState.ts";
import { capture } from "./snapshot.ts";
import { assert, encoder, decoder, jsonBytes } from "./common.ts";

const encodeProviderThread = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ProviderThread));
const encodeTurn = Schema.encodeSync(Schema.toCodecJson(RunnerTurn));
const encodeRunnerItem = Schema.encodeSync(Schema.toCodecJson(RunnerItem));
const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerItem)));
const attempt = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new HarnessRequestFacetError(label, { cause }) });

export function turnBindings(
  ctx: DurableObjectState,
  capability: QualifierCapabilities,
  lineage?: CheckpointLineage,
): HarnessCProductTurnBindings<unknown> {
  let eventOrdinal = 0;
  async function checkpoint(
    checkpoint: HarnessCheckpoint,
    id: string,
    parent: string | null,
    publisher: Parameters<QualifierCapabilities["stageCheckpoint"]>[3],
  ) {
    const state = retainedFacetState(ctx);
    await state.flush();
    const files = capture(state.files, state.threadId, state.boundFiles);
    const nativeSessionId = checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId;
    assert(nativeSessionId, "Native export is missing the actual UUID");
    const filesCheckpoint = { checkpointId: id, parentCheckpointId: parent, files };
    await readRpcData(capability.setCheckpointParent(id, parent));
    const refs = await readRpcData(
      capability.stageCheckpoint(
        id,
        filesCheckpoint,
        encodeHarnessCProductNativeCheckpoint({ schemaVersion: 1, nativeSessionId, checkpoint }),
        publisher,
      ),
    );
    await readRpcData(
      capability.append("facet-checkpoint-export", {
        checkpointId: id,
        nativeSessionId,
        providerThread: encodeProviderThread(checkpoint.snapshot.providerThread),
        rawCounts: [...state.rawOrdinals],
      }),
    );
    return { checkpoint: refs, filesCheckpoint };
  }
  return {
    readTurn: (reference) =>
      attempt("Frozen turn input could not be read", async () =>
        decodeTurn(decoder.decode(await readRpcData(capability.read(reference)))),
      ),
    onEvent: (event, context) =>
      attempt("Public event capture failed", async () => {
        const bytes = encoder.encode(encodeEvent(event));
        const ref = await readRpcData(
          capability.artifact(`event-${context.requestId}-${++eventOrdinal}`, bytes),
        );
        await readRpcData(
          capability.recordRunnerEvent({
            requestId: context.requestId,
            eventJson: decoder.decode(bytes),
            artifact: ref,
          }),
        );
        return ref;
      }),
    writeResult: (result, context) =>
      attempt("Public result capture failed", async () => {
        const ref = await readRpcData(
          capability.artifact(
            `result-${context.requestId}`,
            jsonBytes({
              turn: encodeTurn(result.turn),
              terminal: encodeRunnerItem(result.terminal),
            }),
          ),
        );
        await readRpcData(
          capability.append("runner-result", { requestId: context.requestId, result: ref }),
        );
        return ref;
      }),
    writeInitialCheckpoint: (exported, context) =>
      attempt("Initial checkpoint capture failed", async () => {
        const id = `initial-native-checkpoint-${context.operationId}`;
        const written = await checkpoint(exported, id, null, context.publisher);
        if (lineage) restoreFacetCheckpoint(ctx, id);
        return written;
      }),
    writeCheckpoint: (exported, context) =>
      attempt("Completed checkpoint capture failed", async () => {
        const parent = lineage?.current() ?? (await readRpcData(capability.activeCheckpointId()));
        const written = await checkpoint(exported, context.requestId, parent, context.publisher);
        lineage?.advance(parent, context.requestId);
        return written.checkpoint;
      }),
    verify: (ref, purpose) =>
      attempt("Artifact verification failed", () =>
        purpose === "filesystem"
          ? readRpcData(capability.verifyFiles(ref))
          : readRpcData(capability.verifyArtifact(ref)),
      ),
  };
}
