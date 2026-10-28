import { HarnessProcessExecutionShardObject } from "../../HarnessProcessExecutionShardObject.ts";
import {
  ObservedPlacementStore,
  placementReleaseEvidence,
  type ObservedPlacementRelease,
} from "./placementReleaseObserver.fixture.ts";
import type { HarnessProcessExecutionEnvironment } from "../../HarnessProcessPlacement.ts";
import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";
import type { ProofFilesStore } from "./publicResumeStores.fixture.ts";
import { failTerminalWrite } from "./terminalWriteFailure.fixture.ts";
import type { ProcessSlotState } from "../../../computer/ProcessSlots.ts";
import type { HarnessProcessPlacementRecoveryRecord } from "../../HarnessProcessPlacement.ts";

type ProofShardEnvironment = HarnessProcessExecutionEnvironment & {
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<ProofFilesStore>;
};

export class ProofShard extends HarnessProcessExecutionShardObject {
  constructor(ctx: DurableObjectState, env: ProofShardEnvironment) {
    super(ctx, {
      ...env,
      HARNESS_C_PRODUCT_CAPABILITIES: {
        "proof-platform": env.HARNESS_FILES_STORE.getByName("product-capability-proof"),
      },
    });
  }

  rehydrate() {
    this.ctx.abort("Reconstruct C durable evidence without replaying execution.");
  }
  armTransactionFailure(after: boolean) {
    failTerminalWrite(this.ctx.storage, after);
  }
  placementReleaseEvidence() {
    return placementReleaseEvidence(this.ctx.storage);
  }
  async evidence() {
    const terminal = await this.ctx.storage.list<{
      readonly stopped: boolean;
      readonly joined: unknown;
      readonly identity: unknown;
    }>({ prefix: "harness-process-terminal/v1/" });
    const completion = await this.ctx.storage.list<{
      readonly phase: string;
      readonly result?: { readonly status: string };
      readonly failure?: string;
    }>({ prefix: "harness-process-completion/v1/" });
    const resumes = await this.ctx.storage.list<{
      readonly phase: string;
      readonly prepared?: {
        readonly requested: HarnessProcessResumePreparedRelease;
        readonly observed: HarnessProcessResumePreparedRelease;
      };
    }>({ prefix: "harness-process-resume/v1/" });
    const evictionRestores = await this.ctx.storage.list<{
      readonly phase: string;
      readonly durationMs?: number;
      readonly restoreCount?: number;
      readonly source: {
        readonly checkpoint: unknown;
        readonly threadId: string;
        readonly prepared: { readonly identity: { readonly incarnationNonce: string } };
      };
      readonly publication?: { readonly receipt: { readonly preparedFacetNonce: string } };
    }>({ prefix: "harness-process-eviction/v1/" });
    return {
      evictionRestores: [...evictionRestores.values()]
        .filter((row) => row.phase === "active")
        .map((row) => ({
          durationMs: row.durationMs,
          restoreCount: row.restoreCount,
          threadId: row.source.threadId,
          checkpoint: row.source.checkpoint,
          fromNonce: row.source.prepared.identity.incarnationNonce,
          toNonce: row.publication?.receipt.preparedFacetNonce,
        })),
      terminal: [...terminal.values()].map((row) => ({
        stopped: row.stopped,
        joined: row.joined,
        identity: row.identity,
      })),
      completion: [...completion.values()].map((row) => row.phase),
      completionDetails: [...completion.values()].map((row) => ({
        phase: row.phase,
        result: row.result?.status,
        failure: row.failure,
      })),
      resumes: [...resumes.values()].map((row) => ({
        phase: row.phase,
        prepared: row.prepared !== undefined,
        ...(row.prepared === undefined
          ? {}
          : { selected: row.prepared.requested, observed: row.prepared.observed }),
      })),
    };
  }
}

export class ProofPlacementStore extends ObservedPlacementStore {
  protected override async beforePlacementRelease({
    owner,
    writer,
    proof,
  }: ObservedPlacementRelease) {
    const env = this.env as unknown as {
      PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<ProofShard>;
    };
    const evidence = await env.PROCESS_EXECUTION_SHARDS.getByName(owner).evidence();
    const events = (await this.ctx.storage.get<unknown[]>("proof/releases")) ?? [];
    const proofs = (await this.ctx.storage.get<unknown[]>("proof/release-proofs")) ?? [];
    await this.ctx.storage.put({
      "proof/releases": [...events, evidence],
      "proof/release-proofs": [...proofs, { owner, writer, proof }],
    });
    return undefined;
  }
  async ownership(owner: string) {
    const writer = await this.readWriter(owner);
    if (writer === undefined) return { writer: false, leases: 0, records: [] };
    // Reconstruction fences the retained writer. Diagnostics must not borrow its mutation authority.
    const { state, records } = await this.ctx.storage.transaction(async (transaction) => ({
      state: await transaction.get<ProcessSlotState>("harness-process-slots-v1"),
      records: [
        ...(
          await transaction.list<HarnessProcessPlacementRecoveryRecord>({
            prefix: "harness-process-placement-recovery-v1/",
          })
        ).values(),
      ],
    }));
    return {
      writer: true,
      leases: state?.slots.filter((slot) => slot.holder !== undefined).length ?? 0,
      permits: state?.slots.filter((slot) => slot.holder?.permitted === true).length ?? 0,
      records: records.map((record) => ({
        state: record.state,
        publicationState: record.publicationState,
        receipt: record.publicationReceipt !== undefined,
        invocationAttempt: record.invocationAttempt,
        invocationRequestId: record.invocationRequestId,
        invocationReply: record.invocationReply,
      })),
    };
  }
  async staleWriterRefused(owner: string) {
    const writer = await this.readWriter(owner);
    if (writer === undefined)
      throw new Error("The stale-writer proof requires retained ownership.");
    try {
      await super.releaseWriter(owner, writer);
      return false;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("stale process-shard incarnation"))
        return true;
      throw cause;
    }
  }
  async releases() {
    return (await this.ctx.storage.get<unknown[]>("proof/releases")) ?? [];
  }
}
