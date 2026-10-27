import { HarnessProcessExecutionShardObject } from "../../HarnessProcessExecutionShardObject.ts";
import { HarnessProcessPlacementStoreObject } from "../../HarnessProcessPlacementStoreObject.ts";
import type { HarnessProcessExecutionEnvironment } from "../../HarnessProcessPlacement.ts";
import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";
import type { HarnessProcessPlacementWriter } from "../../HarnessProcessPlacement.ts";
import type { ProofFilesStore } from "./publicResumeStores.fixture.ts";

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
    const storage = this.ctx.storage;
    const original = storage.transaction.bind(storage);
    storage.transaction = async <T>(
      callback: (transaction: DurableObjectTransaction) => Promise<T>,
    ) => {
      storage.transaction = original;
      if (!after) throw new Error("Injected C evidence transaction failure.");
      const result = await original(callback);
      throw new Error(`Injected C evidence reply loss after commit: ${typeof result}`);
    };
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
    return {
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

export class ProofPlacementStore extends HarnessProcessPlacementStoreObject {
  override async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter) {
    const env = this.env as unknown as {
      PROCESS_EXECUTION_SHARDS: DurableObjectNamespace<ProofShard>;
    };
    const before = await env.PROCESS_EXECUTION_SHARDS.getByName(owner).evidence();
    const events = (await this.ctx.storage.get<unknown[]>("proof/releases")) ?? [];
    await this.ctx.storage.put("proof/releases", [...events, before]);
    await super.releaseWriter(owner, writer);
  }
  async ownership(owner: string) {
    const writer = await this.readWriter(owner);
    if (writer === undefined) return { writer: false, leases: 0, records: [] };
    const state = await this.load(owner, writer);
    const records = await this.listRecovery(owner, writer);
    return {
      writer: true,
      leases: state?.slots.filter((slot) => slot.holder !== undefined).length ?? 0,
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
  async releases() {
    return (await this.ctx.storage.get<unknown[]>("proof/releases")) ?? [];
  }
}
