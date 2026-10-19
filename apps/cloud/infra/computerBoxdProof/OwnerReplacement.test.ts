import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  decodeProofReplacementCut,
  encodeProofReplacementCut,
  PROOF_REPLACEMENT_CUT,
  type ProofRecoveryReceipt,
} from "./OwnerReplacement.ts";

const ports = vi.hoisted(() => ({
  run: vi.fn(),
  resume: vi.fn(),
  cleanup: vi.fn(),
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
vi.mock("./SeedProtocol.ts", () => ({
  decodeProofSeed: async (seed: unknown) => seed,
}));
vi.mock("./Provider.ts", () => ({ openProofProvider: async () => ({ close() {} }) }));
vi.mock("./Session.ts", () => ({ runComputerBoxdProof: ports.run }));
vi.mock("./Recovery.ts", () => ({ recoverComputerBoxdProof: ports.resume }));
vi.mock("./Ownership.ts", () => ({
  decodeProofState: (state: unknown) => state,
  ProofOwnership: class {
    readonly client = { close() {} };
    private readonly storage: StoragePort;
    constructor(storage: StoragePort) {
      this.storage = storage;
    }
    save(state: unknown) {
      return this.storage.put("proof-state", state);
    }
    cleanup(signal: AbortSignal) {
      return ports.cleanup(signal);
    }
  },
}));
import {
  createWorker,
  deferred,
  FakeStorage,
  request,
  status,
  type StoragePort,
} from "./AdmissionTestHelpers.ts";

const receipt: ProofRecoveryReceipt = {
  before: { repository: "proof-only", fork: "owned-proof", commit: "before" },
  after: { repository: "proof-only", fork: "owned-proof", commit: "after" },
  inode: 2n ** 60n,
  sourceRef: "owned-source",
  operationId: "owned-command-1",
};
const seed = { sourceCommit: "a".repeat(40), runner: { sha256: "runner" }, programs: {} };

describe("durable proof owner replacement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the cut before abort and resumes only in a fresh constructor without replay", async () => {
    const storage = new FakeStorage();
    let savedAtAbort: unknown;
    ports.run.mockImplementation(
      async (input: { onBeforeApply: (cut: ProofRecoveryReceipt) => Promise<void> }) => {
        await input.onBeforeApply(receipt);
      },
    );
    const first = createWorker(storage, () => {
      savedAtAbort = storage.values.get(PROOF_REPLACEMENT_CUT);
      throw new Error("test object was replaced");
    });
    await first.ready;
    await request(first.worker, "/seed", JSON.stringify(seed));
    expect(
      (await request(first.worker, "/run", JSON.stringify({ seed, mode: "nested-recovery" })))
        .status,
    ).toBe(202);
    await Promise.all(first.background);
    expect(decodeProofReplacementCut(savedAtAbort)).toMatchObject(receipt);
    expect((await status(first.worker)).status).toBe("running");
    expect((await request(first.worker, "/resume")).status).toBe(409);

    const waiting = deferred();
    ports.resume.mockImplementation(async () => waiting.promise);
    const replacement = createWorker(storage);
    await replacement.ready;
    expect((await status(replacement.worker)).checks.ownerConstructorReplaced).toBe("passed");
    expect((await request(replacement.worker, "/run", JSON.stringify({ seed }))).status).toBe(409);
    expect((await request(replacement.worker, "/resume")).status).toBe(202);
    expect((await request(replacement.worker, "/resume")).status).toBe(409);
    waiting.resolve();
    await Promise.all(replacement.background);
    expect(ports.run).toHaveBeenCalledOnce();
    expect(ports.resume).toHaveBeenCalledOnce();
    expect(ports.resume.mock.calls[0]?.[0].expected).toMatchObject(receipt);
    expect((await status(replacement.worker)).status).toBe("passed");
    expect((await request(replacement.worker, "/resume")).status).toBe(409);
  });

  it("keeps ordinary interrupted runs failed and refuses an invalid revision cut", async () => {
    const storage = new FakeStorage();
    storage.values.set("proof-state", {
      status: "running",
      vmNames: [],
      checks: {},
      cleanupConfirmed: false,
    });
    const replacement = createWorker(storage);
    await replacement.ready;
    expect((await status(replacement.worker)).checks.interruptedRun).toBe("failed");
    expect((await request(replacement.worker, "/resume")).status).toBe(409);
    expect(ports.resume).not.toHaveBeenCalled();
    expect(() => encodeProofReplacementCut("owner", { ...receipt, after: receipt.before })).toThrow(
      "Invalid durable",
    );
  });

  it("waits for durable storage before destroying the old owner", async () => {
    const entered = deferred();
    const committed = deferred();
    class BufferedStorage extends FakeStorage {
      override async sync() {
        entered.resolve();
        await committed.promise;
      }
    }
    const storage = new BufferedStorage();
    const abort = vi.fn(() => {
      throw new Error("test object was replaced");
    });
    ports.run.mockImplementation(
      async (input: { onBeforeApply: (cut: ProofRecoveryReceipt) => Promise<void> }) => {
        await input.onBeforeApply(receipt);
      },
    );
    const first = createWorker(storage, abort);
    await first.ready;
    await request(first.worker, "/seed", JSON.stringify(seed));
    await request(first.worker, "/run", JSON.stringify({ seed, mode: "nested-recovery" }));
    const reached = await Promise.race([
      entered.promise.then(() => "durability-fence"),
      Promise.all(first.background).then(() => "destroyed-before-fence"),
    ]);
    expect(reached).toBe("durability-fence");
    expect(abort).not.toHaveBeenCalled();
    expect(decodeProofReplacementCut(storage.values.get(PROOF_REPLACEMENT_CUT))).toMatchObject(
      receipt,
    );
    committed.resolve();
    await Promise.all(first.background);
    expect(abort).toHaveBeenCalledOnce();
  });
});
