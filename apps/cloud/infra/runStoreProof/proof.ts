import { DurableObject } from "cloudflare:workers";
import { HarnessRunStoreObject } from "../../src/harness/HarnessRunStoreObject.ts";
import {
  HarnessRunStoreCommand,
  type HarnessRunStoreResult,
} from "../../src/harness/HarnessRunStore.ts";
import * as Schema from "effect/Schema";
export { HarnessRunStoreObject };
type Env = {
  RUNS: DurableObjectNamespace<HarnessRunStoreObject>;
  PARENTS: DurableObjectNamespace<SupervisorProof>;
};
const decode = Schema.decodeUnknownSync(HarnessRunStoreCommand);

// These fields are diagnostic identity only. All authority and readiness stay in RUNS.
export class SupervisorProof extends DurableObject<Env> {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - DO construction has no Effect runtime.
  readonly nonce = crypto.randomUUID();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS proof_constructors(slot INTEGER PRIMARY KEY, count INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "INSERT INTO proof_constructors(slot,count) VALUES(1,1) ON CONFLICT(slot) DO UPDATE SET count=count+1",
    );
  }
  identity() {
    return {
      nonce: this.nonce,
      constructors: this.ctx.storage.sql
        .exec<{ count: number }>("SELECT count FROM proof_constructors WHERE slot=1")
        .one().count,
    };
  }
  write(runId: string, command: unknown) {
    const validated = decode(command);
    if (validated.type !== "receipt" && validated.type !== "intent")
      throw new Error("Proof supervisor only receives its lease and ordinary writes");
    return this.env.RUNS.getByName(runId).execute(validated);
  }
  replace() {
    this.ctx.abort("owned proof supervisor reconstruction");
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== "/run") return new Response("Not found", { status: 404 });
    // @effect-diagnostics-next-line cryptoRandomUUID:off - this plain Worker names the fixture before calling the store.
    const runId = "run-store-" + crypto.randomUUID();
    const store = env.RUNS.getByName(runId);
    let parent = env.PARENTS.getByName(runId);
    const rows: { stage: string; value: unknown }[] = [];
    const mark = (stage: string, value: unknown) => rows.push({ stage, value });
    const ref = (id: string) => ({ id, sha256: "a".repeat(64), bytes: 4 });
    const controllerKey = "local-proof-controller-capability";
    const firstKey = "local-proof-supervisor-one-capability";
    const secondKey = "local-proof-supervisor-two-capability";
    const publisherKey = "local-proof-independent-publisher-capability";
    const first = { epoch: 1, claimId: "claim-one", supervisorKey: firstKey };
    const second = { epoch: 2, claimId: "claim-two", supervisorKey: secondKey };
    const publisher = {
      invocationId: "same-native-call",
      nativeIncarnationId: "same-native-incarnation",
      publisherKey,
    };
    const declaration = {
      ...publisher,
      requestId: "declare-one",
      locator: ref("supplied-same-call-ref"),
    };
    const { publisherKey: _omitted, ...nativeDeclaration } = declaration;
    const call = (command: unknown) => store.execute(decode(command));
    const reject = async (label: string, expected: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(expected))
          throw new Error(label + " failed with wrong error", { cause: error });
        mark(label, { rejected: true, code: expected });
        return;
      }
      throw new Error(label + " was unexpectedly accepted");
    };
    try {
      const seed = {
        identity: {
          runId,
          hostId: "host",
          threadId: "thread",
          logicalTurnId: "turn",
          filesystemId: "files",
        },
        locator: ref("parent-supplied-locator"),
        config: ref("config"),
        artifacts: [ref("executable")],
      };
      const initialized = await call({
        type: "initialize",
        seed,
        controlKey: controllerKey,
        supervisorKey: firstKey,
        claimId: first.claimId,
        requestId: "initialize-one",
      });
      mark("initialized", initialized.action);
      const identityBefore = await parent.identity();
      mark("parent-before", identityBefore);
      const receipt = {
        receiptId: "seed-readiness",
        kind: "seed-ready",
        subject: ref("executable"),
        evidence: ref("seed-proof"),
      };
      await parent.write(runId, { type: "receipt", runId, supervisor: first, receipt });
      const declared = await call({
        type: "declare",
        runId,
        supervisor: first,
        declaration: nativeDeclaration,
        publisherKey,
      });
      if (declared.action !== "launch-once") throw new Error("First declaration lost launch right");
      mark("first-launch-right", declared.action);
      await call({
        type: "progress",
        runId,
        publisher,
        progress: { sequence: 1, kind: "native-output", reference: ref("progress") },
      });
      try {
        await parent.replace();
      } catch {
        mark("parent-replacement-request", { acknowledged: false });
      }
      // An aborted DO breaks its RPC stub, so reconnect before observing the new instance.
      parent = env.PARENTS.getByName(runId);
      const identityAfter = await parent.identity();
      mark("parent-after", identityAfter);
      if (
        identityAfter.nonce === identityBefore.nonce ||
        identityAfter.constructors !== identityBefore.constructors + 1
      )
        throw new Error("Parent was not reconstructed");
      const takeover = {
        type: "takeover",
        runId,
        controlKey: controllerKey,
        supervisorKey: secondKey,
        expectedEpoch: 1,
        claimId: second.claimId,
        requestId: "takeover-one",
      };
      const taken = await call(takeover);
      mark("takeover", taken.snapshot.supervisor);
      if (taken.snapshot.supervisor.epoch !== 2) throw new Error("Wrong supervisor epoch");
      await reject("stale-supervisor-write", "STALE_SUPERVISOR", () =>
        parent.write(runId, {
          type: "intent",
          runId,
          supervisor: first,
          intent: { intentId: "old-intent", kind: "attach-same-call", reference: ref("same-call") },
        }),
      );
      await parent.write(runId, {
        type: "intent",
        runId,
        supervisor: second,
        intent: { intentId: "new-intent", kind: "attach-same-call", reference: ref("same-call") },
      });
      const completed = await call({
        type: "complete",
        runId,
        publisher,
        terminal: { sequence: 2, status: "completed", reference: ref("native-result") },
      });
      mark("same-publisher-completed", completed.snapshot.terminal);
      const retried = await call({
        type: "declare",
        runId,
        supervisor: second,
        declaration: nativeDeclaration,
        publisherKey,
      });
      if (retried.action !== "observe-only") throw new Error("Retry granted second launch");
      mark("retry", retried.action);
      await reject("replacement-declaration", "CONFLICT", () =>
        call({
          type: "declare",
          runId,
          supervisor: second,
          declaration: { ...nativeDeclaration, nativeIncarnationId: "different-native" },
          publisherKey,
        }),
      );
      const final: HarnessRunStoreResult = await call({ type: "read", runId });
      if (
        JSON.stringify(final.snapshot.seed) !== JSON.stringify(seed) ||
        final.snapshot.receipts.length !== 1 ||
        final.snapshot.intents.length !== 1 ||
        final.snapshot.terminal?.sequence !== 2
      )
        throw new Error("Durable result/readiness was lost");
      const serialized = JSON.stringify(final);
      if (
        [controllerKey, firstKey, secondKey, publisherKey].some((key) => serialized.includes(key))
      )
        throw new Error("Public read leaked an authority key");
      return Response.json({
        ok: true,
        runId,
        rows,
        final,
        proofLimits: [
          "Actual local SQLite DO RPC and explicit supervisor reconstruction only",
          "No native engine/facet execution, live-heap reattach, abort preemption, CPU or deployed qualification",
          "Publisher calls are direct controller-fixture calls, not a native facet",
        ],
      });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          runId,
          rows,
          error: String(error),
          cause: error instanceof Error ? String(error.cause ?? "") : null,
        },
        { status: 500 },
      );
    }
  },
};
