import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ports = vi.hoisted(() => ({
  decodeSeed: vi.fn(),
  openProvider: vi.fn(),
  runProof: vi.fn(),
  cleanup: vi.fn(),
  closeProvider: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("./SeedProtocol.ts", () => ({ decodeProofSeed: ports.decodeSeed }));
vi.mock("./Provider.ts", () => ({ openProofProvider: ports.openProvider }));
vi.mock("./Session.ts", () => ({ runComputerBoxdProof: ports.runProof }));
vi.mock("./Ownership.ts", () => ({
  decodeProofState: (value: unknown) => value,
  ProofOwnership: class {
    readonly client = { close: ports.closeProvider };

    private readonly storage: StoragePort;
    constructor(storage: StoragePort) {
      this.storage = storage;
    }

    save(value: unknown) {
      return this.storage.put("proof-state", value);
    }

    cleanup(signal: AbortSignal) {
      return ports.cleanup(this.storage, signal);
    }
  },
}));

import {
  confirmCleanup,
  createWorker,
  deferred,
  FakeStorage,
  proofToken,
  request,
  status,
  type StoragePort,
} from "./AdmissionTestHelpers.ts";

const seedA = { sourceCommit: "a".repeat(40), runner: { sha256: "runner-a" } };
const seedB = { sourceCommit: "b".repeat(40), runner: { sha256: "runner-b" } };

describe("computer boxd proof admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.decodeSeed.mockResolvedValue(seedA);
    ports.openProvider.mockResolvedValue({});
    ports.runProof.mockResolvedValue(undefined);
    ports.cleanup.mockImplementation((storage: StoragePort) => confirmCleanup(storage));
    ports.closeProvider.mockResolvedValue(undefined);
  });

  it("rejects a late run after recovering a seeded proof", async () => {
    const storage = new FakeStorage();
    const proof = createWorker(storage);
    await proof.ready;
    expect((await request(proof.worker, "/seed", "{}")).status).toBe(202);
    expect((await request(proof.worker, "/recover")).status).toBe(200);

    const lateRun = await request(proof.worker, "/run");
    const lateSeed = await request(proof.worker, "/seed", "{}");
    await Promise.all(proof.background);

    expect({
      cleanupConfirmed: (await status(proof.worker)).cleanupConfirmed,
      lateRun: lateRun.status,
      lateSeed: lateSeed.status,
      sessionDispatches: ports.runProof.mock.calls.length,
    }).toEqual({
      cleanupConfirmed: true,
      lateRun: 409,
      lateSeed: 409,
      sessionDispatches: 0,
    });
  });

  it("keeps recovered admission closed after reconstructing the Worker", async () => {
    const storage = new FakeStorage();
    const first = createWorker(storage);
    await first.ready;
    ports.decodeSeed.mockResolvedValueOnce(seedA).mockResolvedValue(seedB);
    expect((await request(first.worker, "/seed", "{}")).status).toBe(202);
    expect((await request(first.worker, "/recover")).status).toBe(200);

    const reopened = createWorker(storage);
    await reopened.ready;
    const runBeforeSeed = await request(reopened.worker, "/run");
    const lateSeed = await request(reopened.worker, "/seed", "{}");
    const runAfterSeed = await request(reopened.worker, "/run");
    await Promise.all([...first.background, ...reopened.background]);
    const saved = (await storage.get("proof-state")) as { sourceCommit?: string };

    expect({
      runBeforeSeed: runBeforeSeed.status,
      lateSeed: lateSeed.status,
      runAfterSeed: runAfterSeed.status,
      cleanupConfirmed: (await status(reopened.worker)).cleanupConfirmed,
      sourceCommit: saved.sourceCommit,
      sessionDispatches: ports.runProof.mock.calls.length,
    }).toEqual({
      runBeforeSeed: 409,
      lateSeed: 409,
      runAfterSeed: 409,
      cleanupConfirmed: true,
      sourceCommit: seedA.sourceCommit,
      sessionDispatches: 0,
    });
  });

  it("closes admission before provider access and while recovery is in progress", async () => {
    const storage = new FakeStorage();
    const proof = createWorker(storage);
    await proof.ready;
    expect((await request(proof.worker, "/seed", "{}")).status).toBe(202);

    const providerStarted = deferred();
    const providerGate = deferred();
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    let admissionWasPersistedAtProviderAccess = false;
    ports.openProvider.mockImplementation(async () => {
      admissionWasPersistedAtProviderAccess = storage.values.get("proof-admission-closed") === true;
      providerStarted.resolve();
      await providerGate.promise;
      return {};
    });
    ports.cleanup.mockImplementation(async (target: StoragePort) => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
      return confirmCleanup(target);
    });

    const recovery = request(proof.worker, "/recover");
    await providerStarted.promise;
    const whileProviderAccessWaits = await request(proof.worker, "/run");
    providerGate.resolve();
    await cleanupStarted.promise;
    const whileCleanupWaits = await request(proof.worker, "/run");
    cleanupGate.resolve();
    const recovered = await recovery;
    await Promise.all(proof.background);

    expect({
      admissionWasPersistedAtProviderAccess,
      whileProviderAccessWaits: whileProviderAccessWaits.status,
      whileCleanupWaits: whileCleanupWaits.status,
      recovered: recovered.status,
      cleanupConfirmed: (await status(proof.worker)).cleanupConfirmed,
      sessionDispatches: ports.runProof.mock.calls.length,
    }).toEqual({
      admissionWasPersistedAtProviderAccess: true,
      whileProviderAccessWaits: 409,
      whileCleanupWaits: 409,
      recovered: 200,
      cleanupConfirmed: true,
      sessionDispatches: 0,
    });
  });

  it("joins an admitted run before cleanup and rejects an earlier body afterward", async () => {
    const storage = new FakeStorage();
    const proof = createWorker(storage);
    await proof.ready;
    expect((await request(proof.worker, "/seed", "{}")).status).toBe(202);

    const bodyReadStarted = deferred();
    const releaseBody = deferred();
    let bodySent = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyReadStarted.resolve();
          if (bodySent) return;
          return releaseBody.promise.then(() => {
            bodySent = true;
            controller.enqueue(
              new TextEncoder().encode(
                '{"runnerEndpoint":"https://proof.test/api/computer/runner"}',
              ),
            );
            controller.close();
          });
        },
      },
      { highWaterMark: 0 },
    );
    const delayedRun = proof.worker.fetch(
      new Request("https://proof.test/run", {
        method: "POST",
        headers: {
          authorization: `Bearer ${proofToken}`,
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit),
    );
    await bodyReadStarted.promise;

    const sessionStarted = deferred<AbortSignal>();
    const finishSession = deferred();
    let sessionSettled = false;
    ports.runProof.mockImplementation(async (input: { signal: AbortSignal }) => {
      sessionStarted.resolve(input.signal);
      try {
        await finishSession.promise;
      } finally {
        sessionSettled = true;
      }
      input.signal.throwIfAborted();
    });
    expect((await request(proof.worker, "/run")).status).toBe(202);
    const signal = await sessionStarted.promise;
    const abortObserved = deferred();
    let fenceWasPersistedAtAbort = false;
    signal.addEventListener(
      "abort",
      () => {
        fenceWasPersistedAtAbort = storage.values.get("proof-admission-closed") === true;
        abortObserved.resolve();
      },
      { once: true },
    );
    let cleanupCalled = false;
    let cleanupSawSettledSession = false;
    ports.cleanup.mockImplementation(async (target: StoragePort) => {
      cleanupCalled = true;
      cleanupSawSettledSession = sessionSettled;
      return confirmCleanup(target);
    });

    const recovery = request(proof.worker, "/recover");
    await abortObserved.promise;
    const cleanupRanBeforeSessionFinished = cleanupCalled;
    finishSession.resolve();
    const recovered = await recovery;
    releaseBody.resolve();
    const lateRun = await delayedRun;
    await Promise.all(proof.background);
    const finalState = await status(proof.worker);

    expect({
      cleanupRanBeforeSessionFinished,
      cleanupSawSettledSession,
      fenceWasPersistedAtAbort,
      admittedRunDispatches: ports.runProof.mock.calls.length,
      admittedRunCleanupConfirmed: finalState.cleanupConfirmed,
      admittedRunStatus: finalState.status,
      lateRun: lateRun.status,
      recovered: recovered.status,
    }).toEqual({
      cleanupRanBeforeSessionFinished: false,
      cleanupSawSettledSession: true,
      fenceWasPersistedAtAbort: true,
      admittedRunDispatches: 1,
      admittedRunCleanupConfirmed: true,
      admittedRunStatus: "failed",
      lateRun: 409,
      recovered: 200,
    });
  });
});
