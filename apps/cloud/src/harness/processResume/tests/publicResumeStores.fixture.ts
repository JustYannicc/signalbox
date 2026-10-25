// @effect-diagnostics cryptoRandomUUID:off - constructor nonces prove actual local DO reconstruction.
import { HarnessFilesStoreObject } from "../../HarnessFilesStoreObject.ts";
import { HarnessRunStoreObject } from "../../HarnessRunStoreObject.ts";
import { HarnessThreadSupervisorObject } from "../../HarnessThreadSupervisorObject.ts";
import type { HarnessFilesCheckpoint } from "../../HarnessFilesStore.ts";
import type { HarnessRequestCheckpoint } from "../../HarnessRunStore.ts";
import { reference, jsonBytes, type ReleaseMaterial } from "./releaseMaterial.ts";

export const fixtureControl = (epoch: number) => ({
  ownerId: "plain-process-owner",
  incarnationId: `controller-${epoch}`,
  epoch,
  controlKey: `plain-process-a-control-${epoch}-`.repeat(2),
});
export const fixturePublisher = {
  generation: 1,
  facetNonce: "plain-bootstrap",
  publisherKey: "plain-process-a-bootstrap-publisher-".repeat(2),
};
export interface Material {
  readonly checkpoint: HarnessFilesCheckpoint;
  readonly reference: HarnessRequestCheckpoint;
}
export interface ProofConfiguration {
  readonly artifacts: Readonly<Record<string, ReleaseMaterial>>;
  readonly failDispose?: boolean;
  readonly invocationFailure?: "reject" | "failed-finish";
  readonly holdWork?: boolean;
}
export interface ProofStoreEnv {
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<ProofFilesStore>;
}

export class ProofFilesStore extends HarnessFilesStoreObject {
  readonly #waiters = new Map<string, PromiseWithResolvers<void>>();
  readonly #releases = new Map<string, PromiseWithResolvers<void>>();
  readonly #nonce = crypto.randomUUID();
  #fault: { readonly command: string; readonly after: boolean } | undefined;
  instance() {
    return this.#nonce;
  }
  rehydrate() {
    this.ctx.abort("Reconstruct actual A FilesStore for the C proof.");
  }
  async configure(value: ProofConfiguration) {
    await this.ctx.storage.put("proof/config", value);
  }
  async configuration() {
    const value = await this.ctx.storage.get<ProofConfiguration>("proof/config");
    if (value === undefined) throw new Error("The plain fixture configuration is missing.");
    return value;
  }
  async observe(event: string, value: unknown = true) {
    await this.ctx.storage.put(`proof/event/${event}`, value);
    this.#waiters.get(event)?.resolve();
  }
  async wait(event: string) {
    let waiter = this.#waiters.get(event);
    if (waiter === undefined) {
      waiter = Promise.withResolvers();
      this.#waiters.set(event, waiter);
    }
    if ((await this.ctx.storage.get(`proof/event/${event}`)) !== undefined) return;
    await waiter.promise;
  }
  async observations() {
    return Object.fromEntries(await this.ctx.storage.list({ prefix: "proof/event/" }));
  }
  release(event: string) {
    let release = this.#releases.get(event);
    if (release === undefined) {
      release = Promise.withResolvers();
      this.#releases.set(event, release);
    }
    release.resolve();
  }
  async hold(event: string) {
    let release = this.#releases.get(event);
    if (release === undefined) {
      release = Promise.withResolvers();
      this.#releases.set(event, release);
    }
    await release.promise;
  }
  override async fetch(request: Request) {
    const requestId = new URL(request.url).pathname.slice(1);
    await this.observe(`fetch-entered:${requestId}`);
    if ((await this.configuration()).holdWork) await this.hold(`fetch:${requestId}`);
    await this.observe(`fetch-returned:${requestId}`);
    return new Response(`plain-process-fetch:${requestId}`);
  }
  async callback(requestId: string) {
    await this.observe(`callback-entered:${requestId}`);
    if ((await this.configuration()).holdWork) await this.hold(`callback:${requestId}`);
    await this.observe(`callback-returned:${requestId}`);
    return `callback:${requestId}`;
  }
  #heldCommand: string | undefined;
  holdCommand(command: string) {
    this.#heldCommand = command;
  }
  armFailure(command: string, after: boolean) {
    this.#fault = { command, after };
  }
  override async execute(command: unknown) {
    const kind =
      typeof command === "object" && command !== null && "type" in command
        ? command.type
        : undefined;
    if (kind === this.#heldCommand && typeof kind === "string") {
      this.#heldCommand = undefined;
      await this.observe(`command-entered:${kind}`);
      await this.hold(`command:${kind}`);
    }
    const fault = this.#fault?.command === kind ? this.#fault : undefined;
    if (fault !== undefined) this.#fault = undefined;
    if (fault !== undefined && !fault.after) throw new Error("Injected A files write failure.");
    const result = await super.execute(command);
    if (fault !== undefined) throw new Error("Injected lost A files write reply after commit.");
    return result;
  }
  async produce(requestId: string, checkpoint: HarnessFilesCheckpoint): Promise<Material> {
    const runId = this.ctx.id.name!;
    const stageRun = `${runId}/material`;
    const stage = (this.env as ProofStoreEnv).HARNESS_FILES_STORE.getByName(stageRun);
    if (checkpoint.parentCheckpointId === null) {
      await stage.execute({
        type: "initialize",
        runId: stageRun,
        control: fixtureControl(1),
        publisher: fixturePublisher,
        checkpoint,
      });
    } else {
      await stage.execute({
        type: "admitStep",
        runId: stageRun,
        publisher: fixturePublisher,
        stepId: requestId,
        expectedCheckpointId: checkpoint.parentCheckpointId,
      });
      await stage.execute({
        type: "writeCheckpoint",
        runId: stageRun,
        publisher: fixturePublisher,
        stepId: requestId,
        expectedCheckpointId: checkpoint.parentCheckpointId,
        checkpoint,
      });
    }
    const actual = await stage.execute({
      type: "readCheckpoint",
      runId: stageRun,
      publisher: fixturePublisher,
      checkpointId: checkpoint.checkpointId,
    });
    const native = actual.files.find((file) => file.path === "native.json");
    if (native === undefined)
      throw new Error("The plain process did not produce native session bytes.");
    const manifest = [];
    for (const file of [...actual.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const ref = await reference(file.path, file.bytes);
      manifest.push({
        path: file.path,
        mode: file.mode,
        byteLength: ref.bytes,
        sha256: ref.sha256,
      });
    }
    const filesystem = await reference(
      `filesystem:${checkpoint.checkpointId}`,
      jsonBytes(manifest),
    );
    if (filesystem.sha256 !== actual.checkpoint.manifestSha256)
      throw new Error("The actual FilesStore manifest differs from the supplied file material.");
    const material: Material = {
      checkpoint,
      reference: { native: await reference(checkpoint.checkpointId, native.bytes), filesystem },
    };
    await this.ctx.storage.put(`proof/material/${requestId}`, material);
    return material;
  }
  async material(requestId: string) {
    const material = await this.ctx.storage.get<Material>(`proof/material/${requestId}`);
    if (material === undefined)
      throw new Error("The plain process has not produced this checkpoint.");
    return material;
  }
}

export class ProofRunStore extends HarnessRunStoreObject {
  readonly #finished = new Map<string, PromiseWithResolvers<void>>();
  async waitForFinish(requestId: string) {
    let waiter = this.#finished.get(requestId);
    if (waiter === undefined) {
      waiter = Promise.withResolvers();
      this.#finished.set(requestId, waiter);
    }
    const current = await super.execute({ type: "read", runId: this.ctx.id.name });
    if (
      current.snapshot.requests?.entries.some(
        (entry) => entry.request.requestId === requestId && entry.status === "completed",
      )
    )
      return;
    await waiter.promise;
  }
  override async execute(command: unknown) {
    const result = await super.execute(command);
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "request.finish" &&
      "requestId" in command &&
      typeof command.requestId === "string"
    )
      this.#finished.get(command.requestId)?.resolve();
    return result;
  }
}
export class ProofSupervisor extends HarnessThreadSupervisorObject {
  #publicationHold:
    | { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;
  holdPublicationReply() {
    this.#publicationHold = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  }
  async waitPublicationReply() {
    await this.#publicationHold?.entered.promise;
  }
  releasePublicationReply() {
    this.#publicationHold?.release.resolve();
  }

  readonly #nonce = crypto.randomUUID();
  #fault: { readonly command: string; readonly after: boolean } | undefined;
  #publishedReadFailure = false;
  failPublishedRead() {
    this.#publishedReadFailure = true;
  }
  instance() {
    return this.#nonce;
  }
  rehydrate() {
    this.ctx.abort("Reconstruct actual A supervisor for the C proof.");
  }
  armFailure(command: string, after: boolean) {
    this.#fault = { command, after };
  }
  override async execute(command: unknown) {
    const kind =
      typeof command === "object" && command !== null && "type" in command
        ? command.type
        : undefined;
    const fault = this.#fault?.command === kind ? this.#fault : undefined;
    if (fault !== undefined) this.#fault = undefined;
    if (fault !== undefined && !fault.after) throw new Error("Injected A supervisor failure.");
    const result = await super.execute(command);
    if (kind === "publishFreshFacet" && this.#publicationHold !== undefined) {
      this.#publicationHold.entered.resolve();
      await this.#publicationHold.release.promise;
      this.#publicationHold = undefined;
    }
    if (
      kind === "read" &&
      this.#publishedReadFailure &&
      result.snapshot.lifecycle === "published"
    ) {
      this.#publishedReadFailure = false;
      throw new Error("Injected unknown current A authority at activation.");
    }
    if (fault !== undefined) throw new Error("Injected lost A supervisor reply after commit.");
    return result;
  }
}
