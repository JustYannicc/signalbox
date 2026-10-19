// @effect-diagnostics globalDate:off - disposable proof ownership and alarms use the host clock.
import { DurableObject } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import type { RunnerMachineSockets } from "../../src/computer/RunnerMachineSockets.ts";
import { ProofOwnership, decodeProofState, type ProofState } from "./Ownership.ts";
import { openProofProvider } from "./Provider.ts";
import { decodeProofSeed } from "./SeedProtocol.ts";
import { runComputerBoxdProof } from "./Session.ts";

interface Env {
  BOXD_PROOF: DurableObjectNamespace<ComputerBoxdProof>;
  CHILD_WORKERS: WorkerLoader;
  BOXD_API_KEY: string;
  BOXD_PROOF_TOKEN: string;
  BOXD_PROOF_OWNER: string;
}

const ADMISSION_CLOSED = "proof-admission-closed";
const SEED_IDENTITY = "proof-seed-identity";
async function seedIdentity(seed: Awaited<ReturnType<typeof decodeProofSeed>>) {
  // Executables are fixed by decodeProofSeed; bind the remaining caller-supplied inputs.
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      sourceCommit: seed.sourceCommit,
      runnerSha256: seed.runner.sha256,
      programs: seed.programs,
    }),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const runInput = Schema.decodeUnknownSync(
  Schema.Struct({
    runnerEndpoint: Schema.optionalKey(Schema.String),
    seed: Schema.optionalKey(Schema.Unknown),
  }),
);
const evidence = (state: ProofState) => ({
  status: state.status,
  vmNames: state.vmNames,
  checks: state.checks,
  cleanupConfirmed: state.cleanupConfirmed,
});

/** Disposable integration proof. This Worker is never part of the product stack. */
export class ComputerBoxdProof extends DurableObject<Env> {
  private admissionClosed = false;
  private recovering: Promise<void> | undefined;
  private seed: Awaited<ReturnType<typeof decodeProofSeed>> | undefined;
  private ownership: Promise<ProofOwnership> | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private sockets: RunnerMachineSockets | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!/^sb-computer-boxd-[a-z0-9]{8,20}$/.test(env.BOXD_PROOF_OWNER))
      throw new Error("Invalid proof owner");
    ctx.blockConcurrencyWhile(async () => {
      this.admissionClosed = (await ctx.storage.get(ADMISSION_CLOSED)) === true;
      const saved = await ctx.storage.get("proof-state");
      if (saved !== undefined) {
        const state = decodeProofState(saved);
        if (state.status === "running") {
          this.admissionClosed = true;
          await ctx.storage.put(ADMISSION_CLOSED, true);
          await ctx.storage.put("proof-state", {
            ...state,
            status: "failed",
            checks: { ...state.checks, interruptedRun: "failed" },
          });
        }
      }
    });
  }

  private getOwnership() {
    this.ownership ??= openProofProvider(this.env.BOXD_API_KEY)
      .then((client) => new ProofOwnership(this.ctx.storage, this.env.BOXD_PROOF_OWNER, client))
      .catch((error: unknown) => {
        this.ownership = undefined;
        throw error;
      });
    return this.ownership;
  }

  private async state(): Promise<ProofState> {
    const saved = await this.ctx.storage.get("proof-state");
    return saved === undefined
      ? {
          status: "pending",
          vmNames: [
            `computer-${this.env.BOXD_PROOF_OWNER}-source`,
            `computer-${this.env.BOXD_PROOF_OWNER}-command-1`,
          ],
          checks: {},
          cleanupConfirmed: false,
        }
      : decodeProofState(saved);
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/computer/runner") {
      return this.sockets?.fetch(request) ?? new Response("Not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${this.env.BOXD_PROOF_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (path === "/status" && request.method === "GET")
      return Response.json(evidence(await this.state()));
    if (path === "/seed" && request.method === "POST") {
      if (this.admissionClosed) return new Response("Admission closed", { status: 409 });
      const seed = await decodeProofSeed(await request.json());
      const identity = await seedIdentity(seed);
      const expectedIdentity = await this.ctx.storage.get(SEED_IDENTITY);
      const state = await this.state();
      if (
        this.admissionClosed ||
        state.status !== "pending" ||
        this.seed !== undefined ||
        expectedIdentity !== undefined
      )
        return new Response("Already seeded", { status: 409 });
      this.seed = seed;
      await this.ctx.storage.put({
        [SEED_IDENTITY]: identity,
        "proof-state": {
          ...state,
          sourceCommit: seed.sourceCommit,
          runnerSha256: seed.runner.sha256,
          checks: { seedInputs: "passed" },
        },
      });
      return Response.json(evidence(await this.state()), { status: 202 });
    }
    if (path === "/run" && request.method === "POST") {
      if (this.admissionClosed) return new Response("Admission closed", { status: 409 });
      const body = await request.text();
      const options = runInput(body ? JSON.parse(body) : {});
      const endpoint =
        options.runnerEndpoint === undefined
          ? new URL("/api/computer/runner", request.url)
          : new URL(options.runnerEndpoint);
      endpoint.protocol =
        endpoint.protocol === "https:"
          ? "wss:"
          : endpoint.protocol === "http:"
            ? "ws:"
            : endpoint.protocol;
      if (
        !["ws:", "wss:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/api/computer/runner" ||
        endpoint.search ||
        endpoint.hash
      ) {
        return new Response("Invalid Runner endpoint", { status: 400 });
      }
      // An idle object can be evicted after /seed. The run request carries the same
      // validated inputs so admission never relies on memory surviving another request.
      const seed = options.seed === undefined ? this.seed : await decodeProofSeed(options.seed);
      const identity = seed === undefined ? undefined : await seedIdentity(seed);
      const expectedIdentity = await this.ctx.storage.get<string>(SEED_IDENTITY);
      const state = await this.state();
      if (this.admissionClosed || state.status !== "pending" || this.active)
        return new Response("Run unavailable", { status: 409 });
      if (!seed) return new Response("Run seed unavailable", { status: 409 });
      if (identity === undefined || identity !== expectedIdentity)
        return new Response("Run seed mismatch", { status: 409 });
      this.seed = undefined;
      this.controller = new AbortController();
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(600_000)]);
      const admitted = this.ctx.storage.put("proof-state", { ...state, status: "running" });
      // Publish the lifetime before yielding so recovery can abort and await this admission.
      this.active = this.run(seed, endpoint.href, signal, admitted).finally(() => {
        this.active = undefined;
        this.sockets = undefined;
        this.seed = undefined;
      });
      this.ctx.waitUntil(this.active);
      return Response.json(evidence(await this.state()), { status: 202 });
    }
    if (path === "/recover" && request.method === "POST") {
      await this.recover();
      return Response.json(evidence(await this.state()));
    }
    return new Response("Not found", { status: 404 });
  }

  private async run(
    seed: Awaited<ReturnType<typeof decodeProofSeed>>,
    endpoint: string,
    signal: AbortSignal,
    admitted: Promise<void>,
  ) {
    try {
      await admitted;
      signal.throwIfAborted();
      const ownership = await this.getOwnership();
      signal.throwIfAborted();
      await runComputerBoxdProof({
        ownership,
        seed,
        loader: this.env.CHILD_WORKERS,
        endpoint,
        signal,
        publishSockets: (sockets) => {
          this.sockets = sockets;
        },
      });
      const state = await this.state();
      await ownership.save({ ...state, status: "passed" });
    } catch {
      const state = await this.state();
      const checks = Object.fromEntries(
        Object.entries(state.checks).map(([name, outcome]) => [
          name,
          outcome === "pending" ? "failed" : outcome,
        ]),
      );
      await this.ctx.storage.put("proof-state", {
        ...state,
        status: "failed",
        checks: { ...checks, proofRun: "failed" },
      });
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  private recover() {
    this.admissionClosed = true;
    this.seed = undefined;
    this.recovering ??= this.settleRecovery().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  private async settleRecovery() {
    // This permanent fence precedes provider access and survives object eviction.
    await this.ctx.storage.put(ADMISSION_CLOSED, true);
    this.controller?.abort(new Error("The proof owner requested cleanup"));
    const state = await this.state();
    if (state.cleanupConfirmed) return;
    await this.active;
    try {
      const ownership = await this.getOwnership();
      if (await ownership.cleanup(AbortSignal.timeout(90_000))) await ownership.client.close();
    } catch {
      const state = await this.state();
      await this.ctx.storage.put("proof-state", {
        ...state,
        checks: { ...state.checks, providerCleanup: "failed" },
      });
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  override alarm() {
    return this.recover();
  }
}

export default {
  fetch(request: Request, env: Env) {
    const id = env.BOXD_PROOF.idFromName(env.BOXD_PROOF_OWNER);
    return env.BOXD_PROOF.get(id).fetch(request);
  },
};
