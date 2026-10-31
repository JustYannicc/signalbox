import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { layerCrypto } from "../../../../src/platform.ts";
import { runDeploy3Deadline, requireDeploy3Armed } from "../../runtime.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { QualifierEnvironment } from "./environment.ts";
import { proof } from "./environment.ts";
import { assert, errorRecord } from "./common.ts";

export * from "../../../../src/worker.ts";

export { QualifierClaudeFixtures } from "./claudeFixtureObject.ts";
export { QualifierProof } from "./proof.ts";
export { QualifierShard } from "./shard.ts";
export {
  QualifierRunStore,
  QualifierFilesStore,
  QualifierSupervisor,
  QualifierPlacementStore,
} from "./stores.ts";
export { QualifierCommands, QualifierTail } from "./loader.ts";

import { ROUTES } from "./routes.ts";
import { assertQualifierRuntimeConfiguration } from "../environmentContract.ts";

function emitProducerEvent(event: {
  runId: string;
  identity: string;
  producerClass: "outer-worker";
  workerId: string;
  entrypoint: string;
  tag: string;
  route: { method: string; path: string };
  invocationId: string;
  milestone: "entered" | "terminal";
}) {
  const raw = JSON.stringify({ producerEvent: { schema: "sb1070/producer/v1", ...event } });
  Effect.runSync(Console.log(raw));
}
export default class QualifierWorker extends WorkerEntrypoint<QualifierEnvironment> {
  override async scheduled(controller: ScheduledController) {
    await runDeploy3Deadline({ env: this.env, nowMs: controller.scheduledTime });
  }

  async guardDiagnostic() {
    assert(this.env.OBSERVER_GUARD_ONLY === "1", "Guard diagnostics are local-only");
    return await proof(this.env).guardDiagnostic();
  }
  async guardDrain(invocationIds: string[]) {
    assert(this.env.OBSERVER_GUARD_ONLY === "1", "Guard collection is local-only");
    return await proof(this.env).guardDrain(invocationIds);
  }
  override async fetch(request: Request) {
    assertQualifierRuntimeConfiguration(this.env);
    let deployment;
    try {
      deployment = requireDeploy3Armed(this.env);
    } catch {
      return new Response("Deployment is not armed", { status: 503 });
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/deployment-ready") {
      return Response.json({
        runId: deployment.registration.runId,
        workerId: deployment.registration.workerId,
        deadlineUtc: deployment.expiry.deadlineUtc,
        cleanupTokenId: deployment.registration.cleanupTokenId,
        cleanupTokenExpiresOn: deployment.expiry.tokenExpiresOn,
        nativeStarted: false,
      });
    }
    const path = new URL(request.url).pathname;
    if (!ROUTES.some((route) => route.method === request.method && route.path === path))
      return new Response("Unknown qualifier route", { status: 404 });
    if (request.headers.get("x-qualifier-run") !== this.env.RUN_ID)
      return new Response("Qualifier run identity is missing", { status: 403 });
    const invocationId = await Effect.runPromise(
      Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4()).pipe(
        Effect.provide(layerCrypto),
      ),
    );
    const event = {
      runId: this.env.RUN_ID,
      identity: "outer-worker",
      producerClass: "outer-worker" as const,
      workerId: this.env.WORKER_NAME,
      entrypoint: "QualifierWorker.fetch",
      tag: "actual-qualifier-route",
      route: { method: request.method, path },
      invocationId,
    };
    emitProducerEvent({ ...event, milestone: "entered" });
    if (
      this.env.OBSERVER_GUARD_ONLY === "1" &&
      request.method === "POST" &&
      !["/observer-calibration", "/export/blob"].includes(path)
    ) {
      const body = await request.text();
      assert(body === "{}", "Qualifier mutations require an empty JSON object");
    }
    try {
      const response =
        this.env.OBSERVER_GUARD_ONLY === "1" &&
        !["/ready", "/observer-calibration", "/export/page", "/export/blob"].includes(path)
          ? Response.json({ guardOnly: true, method: request.method, path, nativeStarted: false })
          : await proof(this.env).fetch(request);
      const headers = new Headers(response.headers);
      headers.set("x-observer-invocation", invocationId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (cause) {
      const raw = JSON.stringify({
        qualifierRouteFailure: { invocationId, path, cause: errorRecord(cause) },
      });
      Effect.runSync(Console.log(raw));
      return Response.json(
        {
          schema: "sb1070/route-failure/v1",
          runId: this.env.RUN_ID,
          invocationId,
          path,
          failure: errorRecord(cause),
        },
        { status: 500 },
      );
    } finally {
      emitProducerEvent({ ...event, milestone: "terminal" });
    }
  }
}
