import { HarnessRunStoreObject } from "../../../../src/harness/HarnessRunStoreObject.ts";
import { HarnessFilesStoreObject } from "../../../../src/harness/HarnessFilesStoreObject.ts";
import { HarnessThreadSupervisorObject } from "../../../../src/harness/HarnessThreadSupervisorObject.ts";
import {
  ObservedPlacementStore,
  type ObservedPlacementRelease,
} from "./placementReleaseObserver.fixture.ts";
import type { HarnessProcessPlacementStoreObject } from "../../../../src/harness/HarnessProcessPlacementStoreObject.ts";
import type { QualifierShard } from "./shard.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { proof } from "./environment.ts";
import { assert } from "./common.ts";

function commandType(value: unknown) {
  return typeof value === "object" && value !== null && "type" in value
    ? String(value.type)
    : "invalid";
}
function finishRequest(value: unknown): string | undefined {
  if (
    commandType(value) !== "request.finish" ||
    typeof value !== "object" ||
    value === null ||
    !("requestId" in value)
  )
    return;
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

export class QualifierRunStore extends HarnessRunStoreObject {
  readonly #finished = new Map<string, PromiseWithResolvers<void>>();
  async waitForFinish(requestId: string) {
    let waiter = this.#finished.get(requestId);
    if (!waiter) {
      waiter = Promise.withResolvers<void>();
      this.#finished.set(requestId, waiter);
    }
    const current = await super.execute({ type: "read", runId: this.ctx.id.name });
    if (
      current.snapshot.requests?.entries.some(
        (entry) => entry.request.requestId === requestId && entry.status === "completed",
      )
    )
      return current;
    await waiter.promise;
    return await super.execute({ type: "read", runId: this.ctx.id.name });
  }
  override async execute(...args: Parameters<HarnessRunStoreObject["execute"]>) {
    const [command] = args;
    const result = await super.execute(...args);
    if (commandType(command) !== "read")
      await proof(this.env as QualifierEnvironment).append("run-store-committed", {
        object: this.ctx.id.name,
        command,
        result,
      });
    const finished = finishRequest(command);
    if (finished) this.#finished.get(finished)?.resolve();
    return result;
  }
}

export class QualifierFilesStore extends HarnessFilesStoreObject {
  override async execute(...args: Parameters<HarnessFilesStoreObject["execute"]>) {
    const [command] = args;
    const result = await super.execute(...args);
    const type = commandType(command);
    if (type !== "readCheckpoint" && type !== "read")
      await proof(this.env as QualifierEnvironment).append("files-store-committed", {
        object: this.ctx.id.name,
        commandType: type,
        checkpoint: result.checkpoint,
        publication: result.publication,
      });
    return result;
  }
}

export class QualifierSupervisor extends HarnessThreadSupervisorObject {
  override async execute(...args: Parameters<HarnessThreadSupervisorObject["execute"]>) {
    const [command] = args;
    const result = await super.execute(...args);
    if (commandType(command) !== "read")
      await proof(this.env as QualifierEnvironment).append("supervisor-committed", {
        object: this.ctx.id.name,
        command,
        result,
      });
    return result;
  }
}

export class QualifierPlacementStore extends ObservedPlacementStore {
  override async claimWriter(
    ...args: Parameters<HarnessProcessPlacementStoreObject["claimWriter"]>
  ) {
    const [owner, writer] = args;
    await super.claimWriter(...args);
    await proof(this.env as QualifierEnvironment).append("placement-writer-claimed", {
      owner,
      writer,
    });
  }
  protected override async beforePlacementRelease({
    owner,
    writer,
    evidence,
    proof: releaseProof,
  }: ObservedPlacementRelease) {
    const env = this.env as QualifierEnvironment;
    const shard = env.PROCESS_EXECUTION_SHARDS.getByName(owner) as unknown as Pick<
      QualifierShard,
      "evidence"
    >;
    const before = await proof(env).append("placement-before-release", {
      owner,
      writer,
      evidence: await shard.evidence(),
      releaseEvidence: evidence,
      releaseProof,
    });
    return before.sequence;
  }
  protected override async afterPlacementRelease(
    { owner, writer, proof: releaseProof }: ObservedPlacementRelease,
    beforeSequence: number | undefined,
  ) {
    assert(beforeSequence !== undefined, "Placement release observer lost its before sequence");
    await proof(this.env as QualifierEnvironment).recordWriterRelease({
      owner,
      writer,
      beforeSequence,
      terminals: releaseProof.terminals,
      releaseProof,
    });
  }
  async ownership(owner: string) {
    const writer = await this.readWriter(owner);
    if (!writer) return { writer: null, leases: 0, records: [] };
    const state = await this.load(owner, writer);
    const records = await this.listRecovery(owner, writer);
    return {
      writer,
      leases: state?.slots.filter((slot) => slot.holder !== undefined).length ?? 0,
      records,
    };
  }
}
