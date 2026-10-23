// @effect-diagnostics globalDate:off - this plain Workers fixture measures service scheduling at its RPC boundary.
import { createHarnessDurableState } from "../HarnessDurableState.ts";
import { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";

export { HarnessFilesStoreObject, HarnessRunStoreObject, HarnessThreadSupervisorObject };

interface Env {
  readonly HARNESS_RUN_STORE: DurableObjectNamespace<HarnessRunStoreObject>;
  readonly HARNESS_FILES_STORE: DurableObjectNamespace<HarnessFilesStoreObject>;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<HarnessThreadSupervisorObject>;
  readonly BUSY_WORKER: Fetcher;
}

const runId = "workerd-topology-proof";
const control = {
  ownerId: "workerd-owner",
  incarnationId: "workerd-controller-incarnation",
  epoch: 1,
  controlKey: "workerd-controller-control-".repeat(2),
};
const publisher = {
  generation: 1,
  facetNonce: "workerd-facet-nonce",
  publisherKey: "workerd-facet-publisher-".repeat(2),
};
const checkpoint = {
  checkpointId: "workerd-checkpoint-1",
  parentCheckpointId: null,
  files: [
    {
      path: "src/proof.ts",
      mode: 0o644,
      bytes: new TextEncoder().encode("export const proof = true;\n"),
    },
  ],
};
const runInitialization = {
  type: "initialize",
  seed: {
    identity: {
      runId,
      hostId: "workerd-host",
      threadId: "workerd-thread",
      logicalTurnId: "turn-1",
      filesystemId: "workerd-files",
    },
    locator: { id: "locator", sha256: "a".repeat(64), bytes: 1 },
    config: { id: "config", sha256: "b".repeat(64), bytes: 1 },
    artifacts: [],
  },
  controlKey: "workerd-run-control-".repeat(3),
  supervisorKey: "workerd-run-supervisor-".repeat(3),
  claimId: "workerd-claim-1",
  requestId: "workerd-request-1",
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const durable = createHarnessDurableState(env, runId);
    if (url.pathname === "/initialize") {
      const result = await durable.initialize({
        run: runInitialization,
        nativeSessionId: "workerd-native-session",
        control,
        publisher,
        checkpoint,
      });
      return Response.json({ initialized: true, result });
    }
    if (url.pathname === "/recover") {
      const result = await durable.filesStore.execute({
        type: "recoverCheckpoint",
        runId,
        publisher,
        checkpointId: checkpoint.checkpointId,
      });
      return Response.json({
        checkpoint: result.checkpoint,
        file: result.files.map((file) => ({
          path: file.path,
          text: new TextDecoder().decode(file.bytes),
        })),
      });
    }
    if (url.pathname === "/supervisor") {
      const result = await durable.threadSupervisor.execute({ type: "read", runId, control });
      return Response.json(result.snapshot);
    }
    if (url.pathname === "/busy") {
      const startedAt = Date.now();
      const response = await env.BUSY_WORKER.fetch("https://busy.invalid/");
      const result = (await response.json()) as {
        readonly iterations: number;
        readonly checksum: number;
      };
      return Response.json({ ...result, startedAt, finishedAt: Date.now() });
    }
    if (url.pathname === "/journal") {
      const startedAt = Date.now();
      const result = await durable.runStore.execute({ type: "read", runId });
      return Response.json({ startedAt, completedAt: Date.now(), result });
    }
    return new Response("not found", { status: 404 });
  },
};
