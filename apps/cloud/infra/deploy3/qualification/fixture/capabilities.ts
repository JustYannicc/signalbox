import { DurableObject } from "cloudflare:workers";
import { HarnessFilesStoreObject } from "../../../../src/harness/HarnessFilesStoreObject.ts";
import type { HarnessFilesCheckpoint } from "../../../../src/harness/HarnessFilesStore.ts";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import type { HarnessThreadSupervisorPublisher } from "../../../../src/harness/HarnessThreadSupervisor.ts";
import { BlobJournal } from "./blobJournal.ts";
import { readConfiguration, readAsset } from "./configuration.ts";
import { assert, control, encoder, fromBase64, jsonBytes, sameArtifact } from "./common.ts";
import { describeFiles } from "./snapshot.ts";
import { readClaudeQualificationAssets } from "../runtimeAssets.ts";

export interface CapabilityEnvironment {
  PROGRAM_ASSETS: Fetcher;
  CONFIG_SHA256: string;
  HARNESS_FILES_STORE: DurableObjectNamespace<HarnessFilesStoreObject>;
}
const seedPublisher = {
  generation: 1,
  facetNonce: "seed-only",
  publisherKey: "qualifier-seed-publisher-key-".repeat(2),
};

// All mutable proof records belong to this one object. The public A/B/C stores retain lifecycle authority.
export class QualifierCapabilities<
  Env extends CapabilityEnvironment = CapabilityEnvironment,
> extends DurableObject<Env> {
  protected readonly journal = new BlobJournal(this.ctx.storage);
  #configuration: ReturnType<typeof readConfiguration> | undefined;
  #claude: ReturnType<typeof readClaudeQualificationAssets> | undefined;
  protected configuration() {
    return (this.#configuration ??= readConfiguration(
      this.env.PROGRAM_ASSETS,
      this.env.CONFIG_SHA256,
    ));
  }
  protected claudeAssets() {
    return (this.#claude ??= this.configuration().then((config) =>
      readClaudeQualificationAssets(config.claude.runtime.assets, this.env.PROGRAM_ASSETS),
    ));
  }
  async claudeConfiguration() {
    const config = await this.configuration();
    const opened = await this.claudeAssets();
    return {
      catalog: opened.claudeVariants,
      expected: config.claude.expected,
      loaderConfig: opened.loaderConfig,
      runId: config.runId,
      imageDigest: config.machineInventory.imageDigest,
    };
  }
  async prepareClaudeIncarnation(_input: {
    incarnation: string;
    loaderId: string;
    nativeSessionId: string;
    checkpointId: string;
    manifestSha256: string;
    variant: "baseline" | "hooks";
  }): Promise<unknown> {
    throw new Error("The Claude qualification owner must provide its incarnation boundary");
  }
  async hostConfiguration() {
    const config = await this.configuration();
    return {
      runId: config.runId,
      workerName: config.workerName,
      turnJson: config.turnJson,
      imageDigest: config.machineInventory.imageDigest,
    };
  }
  async append(kind: string, value: unknown) {
    return await this.journal.append(kind, value);
  }
  async recordRunnerEvent(input: {
    requestId: string;
    eventJson: string;
    artifact: HarnessRunArtifact;
  }) {
    const receipt = await this.journal.append("runner-event", {
      requestId: input.requestId,
      event: input.artifact,
    });
    await this.ctx.storage.put(
      `event/${input.requestId}/${String(receipt.sequence).padStart(10, "0")}`,
      {
        sequence: receipt.sequence,
        eventJson: input.eventJson,
        artifact: input.artifact,
      },
    );
  }
  async runnerEvents(requestId: string) {
    const rows = await this.ctx.storage.list<{
      sequence: number;
      eventJson: string;
      artifact: HarnessRunArtifact;
    }>({ prefix: `event/${requestId}/` });
    return [...rows.values()];
  }
  async prepareModelIncarnation(_input: {
    incarnation: string;
    loaderId: string;
    restored: boolean;
  }): Promise<unknown> {
    throw new Error("The qualifier model owner must provide its incarnation boundary");
  }
  async artifact(id: string, bytes: Uint8Array) {
    return await this.journal.put(id, bytes);
  }
  async recordRaw(input: {
    incarnation: string;
    channel: "native-stdin" | "native-stdout" | "native-stderr";
    ordinal: number;
    bytes: Uint8Array;
  }) {
    const payload = await this.journal.put(
      `${input.channel}-${input.incarnation}-${input.ordinal}`,
      input.bytes,
    );
    return await this.journal.append(input.channel, {
      incarnation: input.incarnation,
      ordinal: input.ordinal,
      payload,
    });
  }
  async verifyArtifact(ref: HarnessRunArtifact) {
    await this.journal.read(ref);
  }
  async read(input: string | HarnessRunArtifact) {
    if (typeof input !== "string") return await this.journal.read(input);
    const config = await this.configuration();
    const pin = config.programPaths[input];
    assert(pin, `Program seed path not frozen: ${input}`);
    return await readAsset(this.env.PROGRAM_ASSETS, pin);
  }
  async getArtifact(provider: string, releaseId: string) {
    if (provider === "claude-code")
      return (await this.claudeAssets()).ledger.getArtifact(provider, releaseId);
    const config = await this.configuration();
    return provider === "codex" && releaseId === config.expectedRelease.artifact.releaseId
      ? config.expectedRelease.artifact
      : null;
  }
  async loaderConfig(provider: string) {
    if (provider === "claude-code") return (await this.claudeAssets()).loaderConfig;
    assert(provider === "codex", "Only Codex is frozen for this qualifier");
    return (await this.configuration()).releaseLoaderConfig;
  }
  async readArtifact(artifactRef: string, path: string) {
    const config = await this.configuration();
    if (artifactRef !== config.expectedRelease.artifact.artifactRef)
      return await (await this.claudeAssets()).source.read(artifactRef, path);
    assert(
      artifactRef === config.expectedRelease.artifact.artifactRef,
      "Release artifact reference changed",
    );
    const file = config.releaseFiles[path];
    assert(
      file && file.bytes <= 8 * 1024 * 1024,
      "Large release files must use the public range reader",
    );
    return await this.readArtifactChunk(artifactRef, path, 0, file.bytes);
  }
  async readArtifactChunk(artifactRef: string, path: string, offset: number, length: number) {
    const config = await this.configuration();
    if (artifactRef !== config.expectedRelease.artifact.artifactRef) {
      const source = (await this.claudeAssets()).source;
      assert(source.readRange, "Claude qualification source has no public range reader");
      return await source.readRange(artifactRef, path, offset, length);
    }
    assert(
      artifactRef === config.expectedRelease.artifact.artifactRef,
      "Release range selected another artifact",
    );
    const file = config.releaseFiles[path];
    assert(
      file &&
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length > 0 &&
        length <= 8 * 1024 * 1024 &&
        offset + length <= file.bytes,
      "Release range is outside the frozen file",
    );
    const output = new Uint8Array(length);
    let copied = 0;
    for (const chunk of file.chunks) {
      const first = Math.max(offset, chunk.offset);
      const end = Math.min(offset + length, chunk.offset + chunk.bytes);
      if (end <= first) continue;
      const bytes = await readAsset(this.env.PROGRAM_ASSETS, chunk);
      output.set(bytes.subarray(first - chunk.offset, end - chunk.offset), first - offset);
      copied += end - first;
    }
    assert(copied === length, "Release range has a gap");
    return output;
  }
  async catalog(provider: string) {
    assert(provider === "codex" || provider === "claude-code", "Program catalog provider changed");
    return (await this.configuration()).programCatalog;
  }
  async inventory(provider: string) {
    assert(
      provider === "codex" || provider === "claude-code",
      "Machine inventory provider changed",
    );
    return (await this.configuration()).machineInventory;
  }
  async resolveFreshAccess(input: unknown) {
    await this.journal.append("controlled-fresh-access", input);
    return { grant: { scope: "C4-excluded", epoch: 0 }, connections: { servers: [] } };
  }
  async resolveInitialAccess(input: unknown) {
    await this.journal.append("controlled-restore-access", input);
    return { grant: { scope: "C4-excluded", epoch: 0 }, connections: { servers: [] } };
  }
  async resolveTurnAccess(input: unknown) {
    const receipt = await this.journal.append("controlled-turn-access", input);
    return {
      grant: { scope: "C4-excluded", epoch: receipt.sequence },
      connections: { servers: [] },
    };
  }
  async forward() {
    throw new Error("C4 tools-gateway calls are excluded from this qualifier");
  }
  async seedCheckpoint() {
    const config = await this.configuration();
    const runId = `${config.runId}/seed`;
    const files = config.seed.files.map(({ contentBase64, ...file }) => ({
      ...file,
      bytes: fromBase64(contentBase64),
    }));
    const store = this.env.HARNESS_FILES_STORE.getByName(runId);
    const initialized = await store.execute({
      type: "initialize",
      runId,
      control: control(1),
      publisher: seedPublisher,
      checkpoint: { checkpointId: config.seed.checkpointId, parentCheckpointId: null, files },
    });
    const checkpoint = await store.execute({
      type: "readCheckpoint",
      runId,
      publisher: seedPublisher,
      checkpointId: config.seed.checkpointId,
    });
    assert(
      checkpoint.checkpoint.manifestSha256 === initialized.checkpoint.manifestSha256 &&
        checkpoint.files.length === files.length &&
        checkpoint.files.length > 0,
      "Public seed checkpoint read must return all frozen files",
    );
    return checkpoint;
  }
  async stageCheckpoint(
    requestId: string,
    files: HarnessFilesCheckpoint,
    nativeJson: string,
    publisher: HarnessThreadSupervisorPublisher,
  ) {
    const config = await this.configuration();
    const stageRunId = `${config.runId}/stage/${requestId}`;
    const staged = await this.env.HARNESS_FILES_STORE.getByName(stageRunId).execute({
      type: "initialize",
      runId: stageRunId,
      control: control(1),
      publisher,
      checkpoint: { ...files, parentCheckpointId: null },
    });
    const native = await this.journal.put(files.checkpointId, encoder.encode(nativeJson));
    const filesystem = {
      id: files.checkpointId,
      bytes: files.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      sha256: staged.checkpoint.manifestSha256,
    };
    await this.journal.put(`files-${requestId}`, jsonBytes(files));
    await this.ctx.storage.put(`stage/${requestId}`, { stageRunId, native, filesystem, publisher });
    await this.journal.append("checkpoint-artifacts-staged", {
      requestId,
      native,
      filesystem,
      entries: await describeFiles(files.files),
    });
    return { native, filesystem };
  }
  async material(requestId: string): Promise<HarnessFilesCheckpoint> {
    const stage = await this.ctx.storage.get<{
      stageRunId: string;
      publisher: HarnessThreadSupervisorPublisher;
      filesystem: HarnessRunArtifact;
    }>(`stage/${requestId}`);
    assert(stage, "The checkpoint has not been staged");
    const result = await this.env.HARNESS_FILES_STORE.getByName(stage.stageRunId).execute({
      type: "readCheckpoint",
      runId: stage.stageRunId,
      publisher: stage.publisher,
      checkpointId: stage.filesystem.id,
    });
    const parent = await this.ctx.storage.get<string | null>(`checkpoint-parent/${requestId}`);
    assert(parent !== undefined, "Checkpoint parent is missing");
    return {
      checkpointId: result.checkpoint.checkpointId,
      parentCheckpointId: parent,
      files: result.files,
    };
  }
  async activeCheckpointId() {
    const id = await this.ctx.storage.get<string>("active-checkpoint-id");
    assert(id, "The public active checkpoint has not been recorded");
    return id;
  }
  async recordActiveCheckpoint(id: string) {
    await this.ctx.storage.put("active-checkpoint-id", id);
  }
  async setCheckpointParent(requestId: string, parent: string | null) {
    const previous = await this.ctx.storage.get<string | null>(`checkpoint-parent/${requestId}`);
    assert(previous === undefined || previous === parent, "Checkpoint parent changed");
    await this.ctx.storage.put(`checkpoint-parent/${requestId}`, parent);
  }
  async verifyFiles(ref: HarnessRunArtifact) {
    const stages = await this.ctx.storage.list<{
      stageRunId: string;
      publisher: HarnessThreadSupervisorPublisher;
      filesystem: HarnessRunArtifact;
    }>({ prefix: "stage/" });
    const stage = [...stages.values()].find((entry) => sameArtifact(entry.filesystem, ref));
    assert(stage, "Unknown filesystem artifact");
    const result = await this.env.HARNESS_FILES_STORE.getByName(stage.stageRunId).execute({
      type: "readCheckpoint",
      runId: stage.stageRunId,
      publisher: stage.publisher,
      checkpointId: ref.id,
    });
    assert(result.checkpoint.manifestSha256 === ref.sha256, "Staged filesystem artifact changed");
  }
  async exportPage(prefix: string, startAfter?: string) {
    return await this.journal.page(prefix, startAfter);
  }
  async exportBlob(ref: HarnessRunArtifact) {
    return await this.journal.read(ref);
  }
}
