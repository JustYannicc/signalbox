import type { HarnessProcessPlacementWriter } from "../../HarnessProcessPlacement.ts";
import { HarnessProcessPlacementStoreObject } from "../../HarnessProcessPlacementStoreObject.ts";
import { HarnessFilesStoreObject } from "../../HarnessFilesStoreObject.ts";

type InjectedFilesCommand = "syncControl" | "admitStep";

export class ColdCreationFilesStore extends HarnessFilesStoreObject {
  async failNext(command: InjectedFilesCommand) {
    await this.ctx.storage.put(`cold-creation/fail-next/${command}`, true);
  }

  async injectedFailures(command: InjectedFilesCommand) {
    return (await this.ctx.storage.get<number>(`cold-creation/failures/${command}`)) ?? 0;
  }

  override async execute(command: unknown) {
    const kind =
      typeof command === "object" && command !== null && "type" in command
        ? command.type
        : undefined;
    if (
      (kind === "syncControl" || kind === "admitStep") &&
      (await this.ctx.storage.get(`cold-creation/fail-next/${kind}`)) === true
    ) {
      await this.ctx.storage.delete(`cold-creation/fail-next/${kind}`);
      const key = `cold-creation/failures/${kind}`;
      const failures = (await this.ctx.storage.get<number>(key)) ?? 0;
      await this.ctx.storage.put(key, failures + 1);
      throw new Error(`Injected FilesStore ${kind} failure.`);
    }
    return await super.execute(command);
  }
}

export class ColdCreationPlacementStore extends HarnessProcessPlacementStoreObject {
  async failNextWriterClaim() {
    await this.ctx.storage.put("cold-creation/fail-next-writer-claim", true);
  }

  async writerClaimFailureObserved() {
    return (await this.ctx.storage.get<number>("cold-creation/writer-claim-failures")) ?? 0;
  }

  async loseNextWriterReleaseReply() {
    await this.ctx.storage.put("cold-creation/lose-release-reply", true);
  }
  override async releaseWriter(owner: string, writer: HarnessProcessPlacementWriter) {
    await super.releaseWriter(owner, writer);
    if (await this.ctx.storage.get("cold-creation/lose-release-reply")) {
      await this.ctx.storage.delete("cold-creation/lose-release-reply");
      throw new Error("Injected lost reply after committed writer release.");
    }
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
