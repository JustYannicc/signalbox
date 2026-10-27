import { DurableObject } from "cloudflare:workers";
import type { HarnessFilesCheckpoint } from "../../HarnessFilesStore.ts";
import type { HarnessRequestCheckpoint, HarnessRunArtifact } from "../../HarnessRunStore.ts";
import { prepareHarnessFilesCheckpoint as prepareCheckpoint } from "../../HarnessFilesStore.ts";

export class ControlledCreationStore extends DurableObject<Record<string, never>> {
  async failNextExactFacetDisposal(facetNonce: string) {
    await this.ctx.storage.put("cold/fail-exact-facet-dispose", facetNonce);
  }

  async consumeExactFacetDisposalFailure(facetNonce: string) {
    const configured = await this.ctx.storage.get<string>("cold/fail-exact-facet-dispose");
    if (configured !== facetNonce) return false;
    await this.ctx.storage.delete("cold/fail-exact-facet-dispose");
    const count = (await this.ctx.storage.get<number>("cold/exact-facet-dispose-failures")) ?? 0;
    await this.ctx.storage.put("cold/exact-facet-dispose-failures", count + 1);
    return true;
  }

  async exactFacetDisposalFailures() {
    return (await this.ctx.storage.get<number>("cold/exact-facet-dispose-failures")) ?? 0;
  }

  async stageCheckpoint(
    requestId: string,
    checkpoint: HarnessFilesCheckpoint,
    nativeBytes: Uint8Array,
  ): Promise<HarnessRequestCheckpoint> {
    const prepared = await prepareCheckpoint(checkpoint);
    const native = await reference(checkpoint.checkpointId, nativeBytes);
    const filesystem = {
      id: checkpoint.checkpointId,
      bytes: prepared.byteCount,
      sha256: prepared.manifestSha256,
    };
    await this.ctx.storage.put(`cold/native/${checkpoint.checkpointId}`, nativeBytes.slice());
    await this.ctx.storage.put(`cold/files/${checkpoint.checkpointId}`, {
      checkpoint,
      reference: filesystem,
    });
    await this.ctx.storage.put(`cold/material/${requestId}`, checkpoint);
    return { native, filesystem };
  }

  async putArtifact(id: string, bytes: Uint8Array): Promise<HarnessRunArtifact> {
    const copy = bytes.slice();
    await this.ctx.storage.put(`cold/artifacts/${id}`, copy);
    return await reference(id, copy);
  }

  async verifyArtifact(expected: HarnessRunArtifact) {
    const artifact = await this.ctx.storage.get<Uint8Array>(`cold/artifacts/${expected.id}`);
    if (artifact !== undefined && sameReference(await reference(expected.id, artifact), expected))
      return;
    const native = await this.ctx.storage.get<Uint8Array>(`cold/native/${expected.id}`);
    if (native !== undefined && sameReference(await reference(expected.id, native), expected))
      return;
    const files = await this.ctx.storage.get<{
      readonly reference: HarnessRunArtifact;
    }>(`cold/files/${expected.id}`);
    if (files !== undefined && sameReference(files.reference, expected)) return;
    throw new Error(`Controlled creation artifact ${expected.id} is missing or changed.`);
  }

  async nativeCheckpoint(checkpointId: string) {
    return await this.ctx.storage.get<Uint8Array>(`cold/native/${checkpointId}`);
  }

  async material(requestId: string) {
    const checkpoint = await this.ctx.storage.get<HarnessFilesCheckpoint>(
      `cold/material/${requestId}`,
    );
    if (checkpoint === undefined)
      throw new Error(`Controlled checkpoint material for ${requestId} is missing.`);
    return checkpoint;
  }

  async recordLoadedRelease(release: unknown) {
    await this.ctx.storage.put("cold/loaded-release", structuredClone(release));
  }

  async loadedReleaseObservation() {
    return await this.ctx.storage.get("cold/loaded-release");
  }

  async record(event: string, value: unknown = true) {
    const key = `cold/events/${event}`;
    const values = (await this.ctx.storage.get<unknown[]>(key)) ?? [];
    await this.ctx.storage.put(key, [...values, structuredClone(value)]);
  }

  async observations() {
    return Object.fromEntries(await this.ctx.storage.list({ prefix: "cold/events/" }));
  }
}

async function reference(id: string, bytes: Uint8Array): Promise<HarnessRunArtifact> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return {
    id,
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  };
}

function sameReference(left: HarnessRunArtifact, right: HarnessRunArtifact) {
  return left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;
}
