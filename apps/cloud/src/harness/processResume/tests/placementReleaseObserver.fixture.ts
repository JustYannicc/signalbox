import { HarnessProcessPlacementStoreObject } from "../../HarnessProcessPlacementStoreObject.ts";
import type {
  HarnessProcessPlacementWriter,
  HarnessProcessPlacementRecoveryRecord,
} from "../../HarnessProcessPlacement.ts";
import {
  observePlacementRelease,
  observePlacementWriterClaim,
  stopKey,
  type PlacementReleaseEvidence,
  type ObservedPlacementRelease,
} from "../../HarnessProcessPlacementEvidence.ts";
export {
  placementReleaseEvidence,
  selectPlacementReleaseProof,
} from "../../HarnessProcessPlacementEvidence.ts";
export type {
  PlacementReleaseEvidence,
  PlacementReleaseProof,
  ObservedPlacementRelease,
} from "../../HarnessProcessPlacementEvidence.ts";

// One release gate keeps public C tests and the native qualifier from accepting different evidence.
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
    const { evidence, proof } = await observePlacementRelease(
      this.ctx.storage,
      owner,
      writer,
      () => {
        const env = this.env as unknown as {
          PROCESS_EXECUTION_SHARDS: {
            getByName(owner: string): {
              placementReleaseEvidence(): Promise<PlacementReleaseEvidence>;
            };
          };
        };
        return env.PROCESS_EXECUTION_SHARDS.getByName(owner).placementReleaseEvidence();
      },
    );
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
