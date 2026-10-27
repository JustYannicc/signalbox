// @effect-diagnostics nodeBuiltinImport:off - Workerd provides the actual capability RPC boundaries used by the product facet.
import type { ProductFixtureGrant } from "./productGrant.workerd.fixture.ts";
import { DurableObject } from "cloudflare:workers";
import type { HarnessRunArtifact } from "../../../HarnessRunStore.ts";
import type { HarnessCProductProvider } from "../../../HarnessProcessResume.ts";
import type {
  HarnessCProductAccessService,
  HarnessCProductExecutorService,
} from "../../../HarnessCProductCapabilities.ts";
import { reference as referenceArtifact } from "../../../processResume/tests/releaseMaterial.ts";
import type { ProductFixtureExecutor } from "./productExecutor.workerd.fixture.ts";
import { ProductHeapProbe } from "./productHeapProbe.workerd.fixture.ts";
import { machineInventoryFixture } from "../../../../computer/machineInventoryTesting.ts";
import type { HarnessFilesCheckpoint } from "../../../HarnessFilesStore.ts";
import type { HarnessFilesStoreObject } from "../../../HarnessFilesStoreObject.ts";
import type { HarnessThreadSupervisorPublisher } from "../../../HarnessThreadSupervisor.ts";
import { HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES } from "../../../HarnessProcessPlacement.ts";
import type { HarnessRequestFacetFailureCause } from "./memoryFailure.workerd.fixture.ts";
import {
  hasProductFixtureR18Range,
  PRODUCT_FIXTURE_R18_SEED_CHUNK_BYTES,
  readProductFixtureReleaseAsset,
  readProductFixtureR18Range,
  readProductFixtureReleaseRange,
  seedProductFixtureR18Range,
  storeProductFixtureReleaseAsset,
} from "./productChunkStorage.workerd.fixture.ts";
import {
  createProductFixtureState,
  type FixtureRelease,
  type FixtureState,
} from "./productInputs.workerd.fixture.ts";

export { PRODUCT_FIXTURE_R18_SEED_CHUNK_BYTES as PRODUCT_FIXTURE_R18_INPUT_SEED_CHUNK_BYTES };
export const PRODUCT_FIXTURE_R18_INPUT_CHUNK_BYTES = HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES;
export const PRODUCT_FIXTURE_R18_INPUT_PATHS = [
  "manifest.json",
  "worker.js",
  "codex/Cargo.lock",
  "codex/engine.wasm",
  "codex/loader.mjs",
  "codex/manifest.json",
] as const;

type R18InputChunk = {
  readonly totalBytes: number;
  readonly sha256: string;
  readonly offset: number;
  readonly path: string;
  readonly bytes: Uint8Array;
};
export type MemoryModuleInventory = readonly {
  readonly name: string;
  readonly type: "js" | "cjs" | "text" | "wasm";
  readonly bytes: number;
  readonly sha256: string;
}[];

export type ProductFixtureMemoryProofFailureCause = HarnessRequestFacetFailureCause;
export interface ProductFixtureMemoryProofFailure {
  readonly source: "process" | "shard";
  readonly processId?: string;
  readonly error: string;
  readonly causes: readonly ProductFixtureMemoryProofFailureCause[];
}
type ProductFixtureMemoryProofResult =
  | {
      readonly runId: string;
      readonly status: "ready";
      readonly legacyModuleSetHeld: boolean;
      readonly moduleInventory: MemoryModuleInventory;
    }
  | {
      readonly runId: string;
      readonly status: "failed";
      readonly failure: ProductFixtureMemoryProofFailure;
    };
type ProductFixtureMemoryProofReadiness =
  | {
      readonly ready: true;
      readonly legacyModuleSetHeld: boolean;
      readonly moduleInventory: MemoryModuleInventory;
    }
  | Extract<ProductFixtureMemoryProofResult, { readonly status: "failed" }>;

export interface ProductFixtureServiceEnv {
  readonly PRODUCT_EXECUTOR: DurableObjectNamespace<ProductFixtureExecutor>;
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<HarnessFilesStoreObject>;
}

export class ProductFixtureCapability extends DurableObject<ProductFixtureServiceEnv> {
  #heapProbe = new ProductHeapProbe();
  #memoryProofWaiters: (() => void)[] = [];

  holdHeapProbe(bytes: number) {
    return this.#heapProbe.hold(bytes);
  }

  releaseHeapProbe() {
    return this.#heapProbe.release();
  }

  async markMemoryProofReady(
    runId: string,
    legacyModuleSetHeld: boolean,
    moduleInventory: MemoryModuleInventory,
  ) {
    const result = { runId, status: "ready", legacyModuleSetHeld, moduleInventory } as const;
    await this.ctx.storage.put(`fixture/memory-proof/${runId}`, result);
    for (const resolve of this.#memoryProofWaiters.splice(0)) resolve();
    return { ready: true, legacyModuleSetHeld, moduleInventory } as const;
  }

  async markMemoryProofFailed(runId: string, failure: ProductFixtureMemoryProofFailure) {
    const result = { runId, status: "failed", failure } as const;
    await this.ctx.storage.put(`fixture/memory-proof/${runId}`, result);
    for (const resolve of this.#memoryProofWaiters.splice(0)) resolve();
    return { ready: false } as const;
  }

  async waitForMemoryProof(runId: string): Promise<ProductFixtureMemoryProofReadiness> {
    let result = await this.#readMemoryProofResult(runId);
    if (result === undefined) {
      const waiting = new Promise<void>((resolve) => this.#memoryProofWaiters.push(resolve));
      result = await this.#readMemoryProofResult(runId);
      if (result === undefined) {
        await waiting;
        result = await this.#readMemoryProofResult(runId);
      }
    }
    if (result === undefined)
      throw new Error("The C memory proof ended without an activation result.");
    if (result.status === "failed") return result;
    return {
      ready: true,
      legacyModuleSetHeld: result.legacyModuleSetHeld,
      moduleInventory: result.moduleInventory,
    } as const;
  }

  async memoryProofStatus(runId: string) {
    const result = await this.#readMemoryProofResult(runId);
    if (result === undefined) return { runId, status: "pending" } as const;
    return result.status === "failed"
      ? result
      : ({
          runId,
          status: "ready",
          legacyModuleSetHeld: result.legacyModuleSetHeld,
          moduleInventory: result.moduleInventory,
        } as const);
  }

  async #readMemoryProofResult(runId: string) {
    return await this.ctx.storage.get<ProductFixtureMemoryProofResult>(
      `fixture/memory-proof/${runId}`,
    );
  }

  async configure(
    runId: string,
    initialProvider: HarnessCProductProvider = "claude-code",
    useR18Modules = false,
  ) {
    const existing = await this.ctx.storage.get<FixtureState>("fixture/state");
    if (existing?.runId === runId) return this.summary();
    this.#memoryProofWaiters = [];
    for (const key of (await this.ctx.storage.list({ prefix: "fixture/" })).keys())
      await this.ctx.storage.delete(key);
    const r18 = useR18Modules ? await this.r18InputModules() : undefined;
    if (useR18Modules && r18 === undefined)
      throw new Error("The complete pinned R18 module fixture has not been uploaded.");
    const { state, releaseFiles } = await createProductFixtureState(runId, initialProvider, r18);
    for (const provider of ["claude-code", "codex"] as const) {
      const artifactRef = state.releases[provider].artifact.artifactRef;
      for (const [path, bytes] of Object.entries(releaseFiles[provider])) {
        const descriptor = Object.values(
          state.releases[provider].expected.plan.preparedModules,
        ).find((module) => module.path === path);
        const digest = descriptor?.sha256 ?? (await sha256Hex(bytes));
        await storeProductFixtureReleaseAsset(this.ctx.storage, artifactRef, path, bytes, digest);
      }
    }
    try {
      await this.ctx.storage.put("fixture/state", state);
    } catch (cause) {
      throw new Error("Could not store the prepared product fixture state.", { cause });
    }
    return this.summary();
  }

  async initialProvider() {
    return (await this.state()).initialProvider;
  }

  async summary() {
    const state = await this.state();
    return {
      runId: state.runId,
      initialCheckpoint: state.turns["turn-one"]!.reference,
      turns: {
        "turn-one": state.turns["turn-one"]!.reference,
        "turn-two": state.turns["turn-two"]!.reference,
      },
      releases: {
        "claude-code": state.releases["claude-code"].artifact,
        codex: state.releases.codex.artifact,
      },
    };
  }

  async release(provider: HarnessCProductProvider): Promise<FixtureRelease> {
    return (await this.state()).releases[provider];
  }

  async getArtifact(provider: HarnessCProductProvider, releaseId: string) {
    const release = await this.release(provider);
    const fault = await this.ctx.storage.get<string>("fixture/fault");
    if (provider === "codex" && fault === "missing-artifact") return null;
    if (provider === "codex" && fault === "changed-artifact")
      return { ...release.artifact, artifactHash: "0".repeat(64) };
    return release.artifact.releaseId === releaseId ? release.artifact : null;
  }

  async loaderConfig(provider: HarnessCProductProvider) {
    const release = await this.release(provider);
    return {
      trustedComputer: release.trustedComputer,
      maxPreparedModuleBytes: release.maxPreparedModuleBytes,
    };
  }

  async readArtifact(artifactRef: string, path: string) {
    const state = await this.state();
    const material = Object.values(state.releases).find(
      (release) => release.artifact.artifactRef === artifactRef,
    );
    if (material === undefined) throw new Error("The selected fixture artifact is unavailable.");
    const asset = await readProductFixtureReleaseAsset(this.ctx.storage, artifactRef, path);
    if ((await sha256Hex(asset.bytes)) !== asset.sha256)
      throw new Error(`Fixture artifact integrity failed for ${path}.`);
    return asset.bytes;
  }

  async readArtifactChunk(artifactRef: string, path: string, offset: number, length: number) {
    const state = await this.state();
    const material = Object.values(state.releases).find(
      (release) => release.artifact.artifactRef === artifactRef,
    );
    if (
      material === undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES !== 0 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES
    )
      throw new RangeError("The requested release asset chunk is invalid.");
    const paths = (await this.ctx.storage.get<string[]>("fixture/release-read-paths")) ?? [];
    await this.ctx.storage.put("fixture/release-read-paths", [...paths, path]);
    return readProductFixtureReleaseRange(this.ctx.storage, artifactRef, path, offset, length);
  }

  async seedR18ModuleChunk(
    path: string,
    offset: number,
    totalBytes: number,
    sha256: string,
    buffer: ArrayBuffer,
  ) {
    if (!(PRODUCT_FIXTURE_R18_INPUT_PATHS as readonly string[]).includes(path))
      throw new Error(`Unsupported R18 fixture path: ${path}.`);
    const bytes = new Uint8Array(buffer);
    const storedBytes = await seedProductFixtureR18Range(
      this.ctx.storage,
      path,
      offset,
      totalBytes,
      sha256,
      bytes,
    );
    return { path, offset, bytes: storedBytes, totalBytes };
  }

  async readR18InputChunk(path: string, offset: number): Promise<R18InputChunk> {
    if (!(PRODUCT_FIXTURE_R18_INPUT_PATHS as readonly string[]).includes(path))
      throw new Error(`Unsupported R18 fixture path: ${path}.`);
    return { ...(await readProductFixtureR18Range(this.ctx.storage, path, offset)), offset, path };
  }

  async r18InputModules() {
    const modules = Object.create(null) as Record<string, Uint8Array>;
    for (const path of PRODUCT_FIXTURE_R18_INPUT_PATHS) {
      if (!(await hasProductFixtureR18Range(this.ctx.storage, path))) return undefined;
      const first = await readProductFixtureR18Range(this.ctx.storage, path, 0);
      const bytes = new Uint8Array(first.totalBytes);
      for (
        let offset = 0;
        offset < first.totalBytes;
        offset += PRODUCT_FIXTURE_R18_INPUT_CHUNK_BYTES
      ) {
        const chunk =
          offset === 0 ? { ...first, path } : await this.readR18InputChunk(path, offset);
        if (chunk.totalBytes !== first.totalBytes || chunk.sha256 !== first.sha256)
          throw new Error("The R18 fixture metadata changed during assembly.");
        bytes.set(chunk.bytes, offset);
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actualHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (actualHash !== first.sha256)
        throw new Error(`The staged R18 fixture file has the wrong SHA-256: ${path}.`);
      modules[path] = bytes;
    }
    return modules as Record<(typeof PRODUCT_FIXTURE_R18_INPUT_PATHS)[number], Uint8Array>;
  }

  async read(reference: HarnessRunArtifact | string) {
    if (typeof reference === "string") {
      const programs = (await this.state()).programs;
      if (!Object.hasOwn(programs.files, reference))
        throw new Error(`Unknown fixture program ${reference}.`);
      return programs.bytes.slice();
    }
    const bytes = await this.ctx.storage.get<Uint8Array>(`fixture/native/${reference.id}`);
    if (bytes === undefined)
      throw new Error(`Fixture native checkpoint ${reference.id} is missing.`);
    return bytes.slice();
  }

  async catalog(provider: HarnessCProductProvider) {
    if (provider !== "claude-code" && provider !== "codex")
      throw new Error("Unsupported fixture provider.");
    const programs = (await this.state()).programs;
    return {
      sourceIdentity: programs.sourceIdentity,
      codes: programs.codes,
      files: programs.files,
    };
  }

  async inventory(_provider: HarnessCProductProvider) {
    return machineInventoryFixture([
      { path: "/usr/bin/machine-tool", mode: 0o755, uid: 1000, gid: 1000 },
    ]);
  }

  async injectFault(fault: string, native: HarnessRunArtifact) {
    await this.ctx.storage.put("fixture/fault", fault);
    if (fault === "missing-native") await this.ctx.storage.delete(`fixture/native/${native.id}`);
    if (fault === "changed-native") {
      const bytes = await this.read(native);
      const first = bytes[0];
      if (first === undefined) throw new Error("Fixture native bytes are empty.");
      bytes[0] = first ^ 1;
      await this.ctx.storage.put(`fixture/native/${native.id}`, bytes);
    }
  }

  async resolveInitialAccess(
    input: Parameters<HarnessCProductAccessService<ProductFixtureGrant>["resolveInitialAccess"]>[0],
  ) {
    const next = (await this.ctx.storage.get<number>("fixture/access/initial")) ?? 0;
    await this.ctx.storage.put("fixture/access/initial", next + 1);
    return {
      grant: { kind: "initial" as const, requestId: input.nativeSessionId, call: next + 1 },
      connections: { servers: [] },
    };
  }

  async resolveTurnAccess(input: { readonly requestId: string }) {
    const next = (await this.ctx.storage.get<number>("fixture/access/turn")) ?? 0;
    await this.ctx.storage.put("fixture/access/turn", next + 1);
    return {
      grant: { kind: "turn" as const, requestId: input.requestId, call: next + 1 },
      connections: { servers: [] },
    };
  }

  async readTurn(reference: HarnessRunArtifact) {
    const state = await this.state();
    const json = Object.values(state.turns).find((entry) =>
      sameReference(entry.reference, reference),
    )?.json;
    if (json === undefined) throw new Error("Fixture turn reference is unknown.");
    return json;
  }

  async putNative(id: string, bytes: Uint8Array) {
    await this.ctx.storage.put(`fixture/native/${id}`, bytes.slice());
  }

  async stageCheckpoint(requestId: string, checkpoint: HarnessFilesCheckpoint, nativeJson: string) {
    const state = await this.state();
    const stageRunId = `${state.runId}/staged/${requestId}`;
    const stage = this.env.HARNESS_FILES_STORE.getByName(stageRunId);
    const staged = await stage.execute({
      type: "initialize",
      runId: stageRunId,
      control: {
        ownerId: "staging",
        incarnationId: "staging",
        epoch: 1,
        controlKey: "staging-control-key-".repeat(2),
      },
      publisher: {
        generation: 1,
        facetNonce: "staging",
        publisherKey: "staging-publisher-key-".repeat(2),
      },
      checkpoint: { ...checkpoint, parentCheckpointId: null },
    });
    const native = await referenceArtifact(
      checkpoint.checkpointId,
      new TextEncoder().encode(nativeJson),
    );
    await this.putNative(native.id, new TextEncoder().encode(nativeJson));
    const filesystem: HarnessRunArtifact = {
      id: checkpoint.checkpointId,
      bytes: checkpoint.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      sha256: staged.checkpoint.manifestSha256,
    };
    await this.ctx.storage.put(`fixture/material/${requestId}`, checkpoint);
    await this.ctx.storage.put(`fixture/files/${filesystem.id}`, {
      stageRunId,
      reference: filesystem,
    });
    return { native, filesystem };
  }

  async registerFiles(
    reference: HarnessRunArtifact,
    stageRunId: string,
    publisher: HarnessThreadSupervisorPublisher,
  ) {
    await this.ctx.storage.put(`fixture/files/${reference.id}`, {
      stageRunId,
      reference,
      publisher,
    });
  }

  async verifyFiles(reference: HarnessRunArtifact) {
    const material = await this.ctx.storage.get<{
      stageRunId: string;
      reference: HarnessRunArtifact;
      publisher?: HarnessThreadSupervisorPublisher;
    }>(`fixture/files/${reference.id}`);
    if (material === undefined || !sameReference(material.reference, reference))
      throw new Error("The staged file reference changed.");
    const saved = await this.env.HARNESS_FILES_STORE.getByName(material.stageRunId).execute({
      type: "readCheckpoint",
      runId: material.stageRunId,
      publisher: material.publisher ?? {
        generation: 1,
        facetNonce: "staging",
        publisherKey: "staging-publisher-key-".repeat(2),
      },
      checkpointId: reference.id,
    });
    if (saved.checkpoint.manifestSha256 !== reference.sha256)
      throw new Error("The actual staged files differ from their reference.");
  }

  async material(requestId: string) {
    const checkpoint = await this.ctx.storage.get<HarnessFilesCheckpoint>(
      `fixture/material/${requestId}`,
    );
    if (checkpoint === undefined) throw new Error("The request has not exported checkpoint bytes.");
    return checkpoint;
  }

  async putArtifact(id: string, json: string): Promise<HarnessRunArtifact> {
    const bytes = new TextEncoder().encode(json);
    await this.ctx.storage.put(`fixture/artifact/${id}`, bytes);
    return await referenceArtifact(id, bytes);
  }

  async verifyArtifact(reference: HarnessRunArtifact) {
    const state = await this.state();
    if (Object.values(state.turns).some((entry) => sameReference(entry.reference, reference)))
      return;
    const native = await this.ctx.storage.get<Uint8Array>(`fixture/native/${reference.id}`);
    if (
      native !== undefined &&
      sameReference(await referenceArtifact(reference.id, native), reference)
    )
      return;
    const bytes = await this.ctx.storage.get<Uint8Array>(`fixture/artifact/${reference.id}`);
    if (
      bytes === undefined ||
      !sameReference(await referenceArtifact(reference.id, bytes), reference)
    )
      throw new Error(`Fixture artifact ${reference.id} is unavailable or changed.`);
  }

  async fetchModel(request: Request) {
    const rows = (await this.ctx.storage.get<string[]>("fixture/model-requests")) ?? [];
    const url = new URL(request.url);
    await this.ctx.storage.put("fixture/model-requests", [...rows, `${url.pathname}${url.search}`]);
    return new Response(url.pathname.endsWith("/root") ? "root response" : "child response");
  }

  override fetch(request: Request) {
    return this.fetchModel(request);
  }

  async observations() {
    const state = await this.state();
    return {
      executor: await this.env.PRODUCT_EXECUTOR.getByName(
        this.ctx.id.name ?? "fixture",
      ).observation(),
      initialAccessCalls: (await this.ctx.storage.get<number>("fixture/access/initial")) ?? 0,
      turnAccessCalls: (await this.ctx.storage.get<number>("fixture/access/turn")) ?? 0,
      releaseReadPaths: (await this.ctx.storage.get<string[]>("fixture/release-read-paths")) ?? [],
      modelRequests: (await this.ctx.storage.get<string[]>("fixture/model-requests")) ?? [],
      events: Object.fromEntries(await this.ctx.storage.list({ prefix: "fixture/event/" })),
      runnerEvents: [
        ...(
          await this.ctx.storage.list<Uint8Array>({ prefix: "fixture/artifact/event:" })
        ).values(),
      ].map((bytes) => new TextDecoder().decode(bytes)),
      runId: state.runId,
    };
  }

  async observe(name: string, value: unknown) {
    await this.ctx.storage.put(`fixture/event/${name}`, value);
  }

  async forward(
    input: Parameters<HarnessCProductExecutorService<ProductFixtureGrant>["forward"]>[0],
  ) {
    return await this.env.PRODUCT_EXECUTOR.getByName(this.ctx.id.name ?? "fixture").forward(input);
  }

  private async state(): Promise<FixtureState> {
    const value = await this.ctx.storage.get<FixtureState>("fixture/state");
    if (value === undefined) throw new Error("Product fixture was not configured.");
    return value;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameReference(left: HarnessRunArtifact, right: HarnessRunArtifact) {
  return left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;
}
