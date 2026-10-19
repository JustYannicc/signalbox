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

const runInput = Schema.decodeUnknownSync(
  Schema.Struct({
    runnerEndpoint: Schema.optionalKey(Schema.String),
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
      const saved = await ctx.storage.get("proof-state");
      if (saved !== undefined) {
        const state = decodeProofState(saved);
        if (state.status === "running") {
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
      const state = await this.state();
      if (state.status !== "pending" || this.seed !== undefined)
        return new Response("Already seeded", { status: 409 });
      this.seed = await decodeProofSeed(await request.json());
      await this.ctx.storage.put("proof-state", {
        ...state,
        sourceCommit: this.seed.sourceCommit,
        runnerSha256: this.seed.runner.sha256,
        checks: { seedInputs: "passed" },
      });
      return Response.json(evidence(await this.state()), { status: 202 });
    }
    if (path === "/run" && request.method === "POST") {
      const state = await this.state();
      if (state.status !== "pending" || this.active || !this.seed)
        return new Response("Run unavailable", { status: 409 });
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
      const seed = this.seed;
      this.controller = new AbortController();
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(600_000)]);
      await this.ctx.storage.put("proof-state", { ...state, status: "running" });
      this.active = this.run(seed, endpoint.href, signal).finally(() => {
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
  ) {
    try {
      const ownership = await this.getOwnership();
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

  private async recover() {
    const state = await this.state();
    if (state.cleanupConfirmed) return;
    this.controller?.abort(new Error("The proof owner requested cleanup"));
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
