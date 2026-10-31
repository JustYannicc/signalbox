import { HarnessProcessPlacementStoreObject } from "../../../../src/harness/HarnessProcessPlacementStoreObject.ts";
import type {
  HarnessProcessPlacementWriter,
  HarnessProcessPlacementRecoveryRecord,
} from "../../../../src/harness/HarnessProcessPlacement.ts";
import {
  observePlacementRelease,
  observePlacementWriterClaim,
  stopKey,
  placementReleaseEvidence as readPlacementReleaseEvidence,
  type PlacementReleaseEvidence as ProductPlacementReleaseEvidence,
  type PlacementReleaseProof as ProductPlacementReleaseProof,
} from "../../../../src/harness/HarnessProcessPlacementEvidence.ts";
import { equals } from "effect/Equal";
import {
  readCreationRetirementEvidence,
  readModelFence,
  verifyCreationRetirement,
  type CreationRetirementEvidence,
} from "./modelCreationRetirement.fixture.ts";
export { selectPlacementReleaseProof } from "../../../../src/harness/HarnessProcessPlacementEvidence.ts";

export type PlacementReleaseEvidence = ProductPlacementReleaseEvidence & {
  readonly creations?: readonly CreationRetirementEvidence[];
};
export type PlacementReleaseProof =
  | ProductPlacementReleaseProof
  | {
      readonly kind: "creation-parent-destroyed";
      readonly receipt: ReturnType<typeof verifyCreationRetirement>;
      readonly terminals: readonly [];
    };
export interface ObservedPlacementRelease {
  readonly owner: string;
  readonly writer: HarnessProcessPlacementWriter;
  readonly evidence: PlacementReleaseEvidence;
  readonly proof: PlacementReleaseProof;
}

export async function placementReleaseEvidence(storage: DurableObjectStorage) {
  return {
    ...(await readPlacementReleaseEvidence(storage)),
    creations: await readCreationRetirementEvidence(storage),
  };
}

// Release requires the exact writer and its completed durable retirement.
export class ObservedPlacementStore extends HarnessProcessPlacementStoreObject {
  protected override async writerClaimedIn(
    transaction: DurableObjectTransaction,
    owner: string,
    previous: HarnessProcessPlacementWriter | undefined,
    writer: HarnessProcessPlacementWriter,
  ) {
    await observePlacementWriterClaim(transaction, owner, previous, writer);
  }

  protected override async recoveryRemovedIn(
    transaction: DurableObjectTransaction,
    owner: string,
    writer: HarnessProcessPlacementWriter,
    record: HarnessProcessPlacementRecoveryRecord,
  ) {
    await transaction.put(stopKey(owner, writer, record.loaderId), { owner, writer, record });
  }

  override async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter) {
    // Reject a stale receiver before consulting the current shard's evidence.
    await super.load(owner, writer);
    const env = this.env as unknown as {
      PROCESS_EXECUTION_SHARDS: {
        getByName(owner: string): {
          placementReleaseEvidence(): Promise<PlacementReleaseEvidence>;
        };
      };
    };
    const evidence = await env.PROCESS_EXECUTION_SHARDS.getByName(owner).placementReleaseEvidence();
    const creations = (evidence.creations ?? []).filter(
      (row) =>
        row.record.claim.ownerId === owner &&
        row.boundary.phase === "restoring" &&
        row.boundary.published === false &&
        row.boundary.requestPublisher.generation === 1,
    );
    let proof: PlacementReleaseProof;
    if (creations.length > 0) {
      if (creations.length !== 1) throw new Error("Creation retirement is ambiguous.");
      const slots = await super.load(owner, writer);
      if (
        slots?.owner !== owner ||
        slots.slots.some((slot) => slot.holder !== undefined || slot.invalidating !== undefined) ||
        (await super.listRecovery(owner, writer)).length !== 0
      )
        throw new Error("Creation retirement still has held slots or recovery records.");
      const fences = new Map(evidence.fences);
      const currentFence = readModelFence(fences.get("harness-process-incarnation/v1/current"));
      const receiver = await this.ctx.storage.get<unknown>(
        `harness-process-incarnation/v1/receiver/${encodeURIComponent(owner)}`,
      );
      if (!equals(currentFence, readModelFence(receiver)))
        throw new Error("Creation retirement has another current placement fence.");
      const receipt = verifyCreationRetirement({
        owner,
        writer,
        currentFence,
        history: evidence.fences
          .filter(([key]) => key.startsWith("harness-process-incarnation/v1/history/"))
          .map(([, value]) => readModelFence(value)),
        creation: creations[0]!,
        completed: false,
        writerReleased: false,
      });
      proof = { kind: "creation-parent-destroyed", receipt, terminals: [] };
    } else {
      ({ proof } = await observePlacementRelease(
        this.ctx.storage,
        owner,
        writer,
        async () => evidence,
      ));
    }
    const observed = { owner, writer, evidence, proof };
    const sequence = await this.beforePlacementRelease(observed);
    await super.releaseWriter(owner, writer);
    if (
      (await super.readWriter(owner)) !== undefined ||
      !(await super.writerReleased(owner, writer))
    )
      throw new Error("Placement writer release is not durable.");
    await this.afterPlacementRelease(observed, sequence);
  }

  protected async beforePlacementRelease(
    _observed: ObservedPlacementRelease,
  ): Promise<number | undefined> {
    return undefined;
  }
  protected async afterPlacementRelease(
    _observed: ObservedPlacementRelease,
    _sequence: number | undefined,
  ): Promise<void> {}
}
