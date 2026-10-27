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
import { machineInventoryFixture } from "../../../../computer/machineInventoryTesting.ts";
import type { HarnessFilesCheckpoint } from "../../../HarnessFilesStore.ts";
import type { HarnessFilesStoreObject } from "../../../HarnessFilesStoreObject.ts";
import type { HarnessThreadSupervisorPublisher } from "../../../HarnessThreadSupervisor.ts";
import {
  createProductFixtureState,
  type FixtureRelease,
  type FixtureState,
} from "./productInputs.workerd.fixture.ts";

export interface ProductFixtureServiceEnv {
  readonly PRODUCT_EXECUTOR: DurableObjectNamespace<ProductFixtureExecutor>;
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<HarnessFilesStoreObject>;
}

export class ProductFixtureCapability extends DurableObject<ProductFixtureServiceEnv> {
  async configure(runId: string) {
    const existing = await this.ctx.storage.get<FixtureState>("fixture/state");
    if (existing?.runId === runId) return this.summary();
    for (const key of (await this.ctx.storage.list({ prefix: "fixture/" })).keys())
      await this.ctx.storage.delete(key);
    const state = await createProductFixtureState(runId);
    await this.ctx.storage.put("fixture/state", state);
    return this.summary();
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
    const bytes = material?.files[path];
    if (bytes === undefined) throw new Error(`Fixture artifact does not contain ${path}.`);
    return bytes.slice();
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

function sameReference(left: HarnessRunArtifact, right: HarnessRunArtifact) {
  return left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;
}
