// @effect-diagnostics nodeBuiltinImport:off - the proof uses a real child process, SQLite store and local HTTP server.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  createProcessSlots,
  type ProcessSlotState,
  type ProcessSlotStore,
} from "../../../computer/ProcessSlots.ts";
import {
  controlKey,
  fixture as runStoreFixture,
  initial,
  reference,
  replacement,
  runId,
  supervisor,
  takeover,
} from "../../runStore/tests/fixture.ts";
import { install, requestPublisher } from "../../runStore/tests/requestFixture.ts";
import {
  createPlainCheckpointFiles,
  createPlainGitWorkspace,
  plainCheckpointDigest,
  type PlainNativeState,
  type PlainWorkspaceState,
} from "./checkpointFiles.ts";
import { PlainProcess, type PlainProcessJoin, type PlainProcessReady } from "./plainProcess.ts";

const deferred = <A>() => Promise.withResolvers<A>();

const artifact = (id: string, bytes: Uint8Array) => ({
  id,
  bytes: bytes.byteLength,
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
});

const checkpoint = (files: ReturnType<typeof createPlainCheckpointFiles>, generation: number) => {
  const contents = files.read();
  return {
    native: artifact(`native-${generation}`, contents.nativeBytes),
    filesystem: artifact(`filesystem-${generation}`, contents.workspaceBytes),
  };
};

interface FetchGate {
  readonly started: Promise<void>;
  readonly release: () => void;
}

async function makeFetchServer() {
  const gates = new Map<
    string,
    {
      readonly started: ReturnType<typeof deferred<void>>;
      readonly release: ReturnType<typeof deferred<void>>;
    }
  >();
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const requestId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
        "requestId",
      );
      if (!requestId) throw new Error("Plain process fetch omitted its request id.");
      const gate = gates.get(requestId);
      if (gate) {
        gate.started.resolve();
        await gate.release.promise;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ requestId }));
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("Local fetch fixture failed."));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local fetch server did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}/step`,
    hold(requestId: string): FetchGate {
      const gate = { started: deferred<void>(), release: deferred<void>() };
      gates.set(requestId, gate);
      return { started: gate.started.promise, release: () => gate.release.resolve() };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function makeProcessSlots() {
  let state: ProcessSlotState | undefined;
  const store: ProcessSlotStore = {
    load: async () => state,
    save: async (next) => {
      state = structuredClone(next);
    },
  };
  return createProcessSlots({
    owner: "supervisor/plain-process-resume-test",
    inFlightLimit: 1,
    residentByteLimit: 1024,
    store,
    scheduleQuantum(callback) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) callback();
      });
      return () => {
        cancelled = true;
      };
    },
    invalidate() {},
    reconcile: async () => ({ acknowledged: true }),
  });
}

const acquireLease = (slots: Awaited<ReturnType<typeof makeProcessSlots>>, codeId: string) =>
  slots.acquire({
    owner: "supervisor/plain-process-resume-test",
    codeId,
    residentBytes: 1,
    signal: new AbortController().signal,
  });

const finishStep = async (
  store: ReturnType<ReturnType<typeof runStoreFixture>["open"]>,
  requestId: string,
  generation: number,
  files: ReturnType<typeof createPlainCheckpointFiles>,
) => {
  const refs = checkpoint(files, generation);
  const resultBytes = Buffer.from(`result:${requestId}`);
  await store.call({
    type: "request.finish",
    runId,
    requestId,
    publisher: requestPublisher(generation),
    finish: {
      sequence: 1,
      status: "completed",
      result: artifact(`result-${requestId}`, resultBytes),
      checkpoint: refs,
    },
  });
  return refs;
};

describe("plain-process resume proof", () => {
  it("commits checkpoint bytes before joining a held invocation, then restores the same session in a new process", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "harness-process-resume-"));
    const fetchServer = await makeFetchServer();
    const slots = await makeProcessSlots();
    const runStore = runStoreFixture().open();
    const gitWorkspace = createPlainGitWorkspace(directory);
    const processes: Array<{
      readonly process: PlainProcess;
      readonly lease: Awaited<ReturnType<typeof acquireLease>>;
      readonly stepId?: string;
      released: boolean;
    }> = [];
    const fetchGate = fetchServer.hold("step-one");
    const native: PlainNativeState = {
      nativeSessionId: "native-session-from-checkpoint",
      turn: 0,
      transcript: [],
    };
    const workspace: PlainWorkspaceState = { files: {} };
    const files = createPlainCheckpointFiles(directory, native, workspace);
    const initialRefs = checkpoint(files, 0);

    try {
      await runStore.call(initial);
      await runStore.call({
        type: "request.mode",
        runId,
        controlKey,
        requestId: "resume-test-mode",
        checkpoint: initialRefs,
      });
      await runStore.call(install(1));
      await runStore.call({
        type: "request.offer",
        runId,
        supervisor,
        request: { requestId: "step-one", input: reference("input-step-one") },
      });
      await runStore.call({
        type: "request.admit",
        runId,
        requestId: "step-one",
        publisher: requestPublisher(1),
      });

      const firstLease = await acquireLease(slots, "plain-process-1");
      const first = await PlainProcess.open(files, fetchServer.url, gitWorkspace);
      const firstResource = {
        process: first,
        lease: firstLease,
        stepId: "step-one",
        released: false,
      };
      processes.push(firstResource);
      const firstReady: PlainProcessReady = await first.ready;
      expect(firstReady.nativeSessionId).toBe(native.nativeSessionId);
      expect(firstReady.native).toEqual(native);
      expect(firstReady.gitWorkspace).toEqual(gitWorkspace.snapshot());
      const firstIdentity = {
        shardOwner: "supervisor/plain-process-resume-test",
        loaderId: firstLease.lease.loaderId,
        facetKey: firstLease.lease.loaderId,
        incarnationNonce: firstReady.processNonce,
      };

      const invocation = first.invoke("step-one", "first committed step");
      const producedCheckpoint = await first.checkpoint("step-one");
      expect(producedCheckpoint.native.turn).toBe(1);
      expect(producedCheckpoint.native.transcript).toEqual(["first committed step"]);
      files.write(producedCheckpoint.native, producedCheckpoint.workspace);
      const firstRefs = await finishStep(runStore, "step-one", 1, files);
      await first.checkpointCommitted("step-one");
      await fetchGate.started;

      const stopped = await first.stop();
      expect(stopped.acknowledged).toBe(true);
      let joined = false;
      const joining = first.join("step-one").then((value) => {
        joined = true;
        return value;
      });
      expect(joined).toBe(false);

      fetchGate.release();
      await first.callbackReceived("step-one");
      await first.fetchSettled("step-one");
      expect(joined).toBe(false);
      await first.releaseCallback("step-one");
      const settlement: PlainProcessJoin = await joining;
      expect(settlement).toEqual({
        invocationRpc: true,
        fetch: true,
        ports: true,
        processExit: true,
      });
      await invocation;
      await first.cleanup("step-one");
      await slots.release(firstLease.lease, { acknowledged: true });
      firstResource.released = true;

      const committed = await runStore.call({ type: "read", runId });
      expect(committed.snapshot.requests?.checkpoint).toEqual(firstRefs);
      expect(files.read().nativeBytes.toString("utf8")).toBe(
        JSON.stringify(producedCheckpoint.native),
      );

      await runStore.call(takeover);
      await expect(
        runStore.call({
          type: "request.offer",
          runId,
          supervisor,
          request: { requestId: "stale-supervisor", input: reference("stale-input") },
        }),
      ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });

      await runStore.call(install(2));
      await runStore.call({
        type: "request.offer",
        runId,
        supervisor: replacement,
        request: { requestId: "step-two", input: reference("input-step-two") },
      });
      await expect(
        runStore.call({
          type: "request.admit",
          runId,
          requestId: "step-two",
          publisher: requestPublisher(1),
        }),
      ).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
      expect(
        await runStore.call({
          type: "request.admit",
          runId,
          requestId: "step-two",
          publisher: requestPublisher(2),
        }),
      ).toMatchObject({ action: "execute-once" });

      const secondLease = await acquireLease(slots, "plain-process-2");
      const second = await PlainProcess.open(files, fetchServer.url, gitWorkspace);
      const secondResource = {
        process: second,
        lease: secondLease,
        stepId: "step-two",
        released: false,
      };
      processes.push(secondResource);
      const secondReady = await second.ready;
      const secondIdentity = {
        shardOwner: "supervisor/plain-process-resume-test",
        loaderId: secondLease.lease.loaderId,
        facetKey: secondLease.lease.loaderId,
        incarnationNonce: secondReady.processNonce,
      };
      expect(secondReady.processId).not.toBe(firstReady.processId);
      expect(secondIdentity.shardOwner).toBe(firstIdentity.shardOwner);
      expect(secondIdentity.loaderId).not.toBe(firstIdentity.loaderId);
      expect(secondIdentity.facetKey).toBe(secondIdentity.loaderId);
      expect(secondIdentity.incarnationNonce).not.toBe(firstIdentity.incarnationNonce);
      expect(secondReady.nativeSessionId).toBe(native.nativeSessionId);
      expect(secondReady.native).toEqual(producedCheckpoint.native);
      expect(secondReady.workspace).toEqual(producedCheckpoint.workspace);
      expect(secondReady.gitWorkspace).toEqual(firstReady.gitWorkspace);
      const persisted = files.read();
      expect(secondReady.checkpointDigest).toBe(
        plainCheckpointDigest(persisted.nativeBytes, persisted.workspaceBytes),
      );

      const nextInvocation = second.invoke("step-two", "second committed step");
      const nextCheckpoint = await second.checkpoint("step-two");
      files.write(nextCheckpoint.native, nextCheckpoint.workspace);
      const secondRefs = await finishStep(runStore, "step-two", 2, files);
      await second.checkpointCommitted("step-two");
      await second.callbackReceived("step-two");
      await second.releaseCallback("step-two");
      const nextResult = await nextInvocation;
      expect(nextResult.native.turn).toBe(2);
      expect(nextResult.native.transcript).toEqual([
        "first committed step",
        "second committed step",
      ]);
      expect(
        await runStore.call({
          type: "request.admit",
          runId,
          requestId: "step-two",
          publisher: requestPublisher(2),
        }),
      ).toMatchObject({ action: "committed" });
      await second.cleanup("step-two");
      await slots.release(secondLease.lease, { acknowledged: true });
      secondResource.released = true;

      const finished = await runStore.call({ type: "read", runId });
      expect(finished.snapshot.requests?.checkpoint).toEqual(secondRefs);
    } finally {
      fetchGate.release();
      for (const resource of processes.toReversed()) {
        await resource.process.cleanup(resource.stepId);
        if (!resource.released) {
          await slots.release(resource.lease.lease, { acknowledged: true });
          resource.released = true;
        }
      }
      runStore.close();
      await fetchServer.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
