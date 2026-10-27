import type { HarnessProcessPlacementWriter } from "../../processPlacement/storeSchema.ts";
import { HarnessProcessPlacementStoreObject } from "../../HarnessProcessPlacementStoreObject.ts";

export class ColdCreationPlacementStore extends HarnessProcessPlacementStoreObject {
  async failNextWriterClaim() {
    await this.ctx.storage.put("cold-creation/fail-next-writer-claim", true);
  }

  async writerClaimFailureObserved() {
    return (await this.ctx.storage.get<number>("cold-creation/writer-claim-failures")) ?? 0;
  }

  async writerStatus(owner: string) {
    return { writer: (await this.readWriter(owner)) !== undefined };
  }

  override async claimWriter(owner: string, writer: HarnessProcessPlacementWriter) {
    if (await this.ctx.storage.get("cold-creation/fail-next-writer-claim")) {
      await this.ctx.storage.delete("cold-creation/fail-next-writer-claim");
      const failures =
        (await this.ctx.storage.get<number>("cold-creation/writer-claim-failures")) ?? 0;
      await this.ctx.storage.put("cold-creation/writer-claim-failures", failures + 1);
      throw new Error("Injected failure after the durable creation claim.");
    }
    return await super.claimWriter(owner, writer);
  }
}
