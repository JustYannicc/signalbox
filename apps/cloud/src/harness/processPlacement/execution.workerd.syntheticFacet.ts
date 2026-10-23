export const syntheticFacetModule = `import { DurableObject } from "cloudflare:workers";

let moduleNonce;
const getModuleNonce = () => (moduleNonce ??= crypto.randomUUID());
const joined = { invocationRpc: true, fetch: true, ports: true };

export class SyntheticFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.identityValue = {
      shardOwner: env.HARNESS_PROCESS_SHARD_OWNER,
      loaderId: env.HARNESS_PROCESS_LOADER_ID,
      facetKey: env.HARNESS_PROCESS_FACET_KEY,
      incarnationNonce: env.HARNESS_PROCESS_INCARNATION_NONCE,
    };
    this.constructorNonce = crypto.randomUUID();
    this.phases = [];
    this.disposalFailures = Number(env.DISPOSAL_FAILURES ?? "0");
  }

  async fetch(request) {
    if (new URL(request.url).pathname !== "/identity")
      return new Response("not found", { status: 404 });
    return Response.json(await this.identity());
  }

  async identity() {
    this.phases.push("identity");
    return {
      facetKey: this.identityValue.facetKey,
      incarnationNonce: this.identityValue.incarnationNonce,
    };
  }

  async prepareInert(input) {
    if (
      input.identity.shardOwner !== this.identityValue.shardOwner ||
      input.identity.loaderId !== this.identityValue.loaderId ||
      input.identity.facetKey !== this.identityValue.facetKey ||
      input.identity.incarnationNonce !== this.identityValue.incarnationNonce ||
      this.phases.join(",") !== "identity"
    ) throw new Error("Facet preparation identity changed.");
    this.prepared = {
      nativeSessionId: input.nativeSessionId,
      checkpointId: input.checkpointId,
      manifestRevision: input.manifestRevision,
    };
    this.phases.push("prepare");
    return {
      ...this.prepared,
      facetKey: this.identityValue.facetKey,
      incarnationNonce: this.identityValue.incarnationNonce,
      joined,
    };
  }

  async activate(receipt) {
    if (receipt.status !== "confirmed" || !this.prepared || this.phases.at(-1) !== "prepare")
      throw new Error("Facet activation lacks confirmed preparation.");
    this.phases.push("activate");
  }

  async invoke(input) {
    if (
      this.phases.at(-1) !== "activate" ||
      !input.requestContextId ||
      input.processId !== this.env.HARNESS_PROCESS_ID ||
      input.loaderId !== this.identityValue.loaderId
    ) throw new Error("Facet invocation does not match activated state.");
    this.phases.push("invoke");
    return {
      value: {
        processId: input.processId,
        requestContextId: input.requestContextId,
        loaderId: this.identityValue.loaderId,
        facetKey: this.identityValue.facetKey,
        incarnationNonce: this.identityValue.incarnationNonce,
        moduleNonce: getModuleNonce(),
        constructorNonce: this.constructorNonce,
        phases: [...this.phases],
      },
      stopAcknowledged: true,
      joined,
    };
  }

  async stop() {
    if (!this.phases.includes("invoke"))
      throw new Error("Facet stop lost its invocation state.");
    if (!this.phases.includes("stop")) this.phases.push("stop");
    return { acknowledged: true };
  }

  async join() {
    if (!this.phases.includes("stop"))
      throw new Error("Facet join lost its stop state.");
    if (!this.phases.includes("join")) this.phases.push("join");
    return joined;
  }

  async dispose() {
    if (!this.phases.includes("join"))
      throw new Error("Facet disposal lost its joined state.");
    this.phases.push("dispose");
    if (this.disposalFailures > 0) {
      this.disposalFailures--;
      throw new Error("private-prompt-sentinel");
    }
  }
}`;
