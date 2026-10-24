import { describe, expect, it, vi } from "vite-plus/test";
import { bashMain } from "./workerEntrypoints.ts";

const command = { argv: ["bash"], env: {} };
const exit = { exitCode: 17, signal: 0, coreDumped: false };

function fixture(snapshotFails = false, snapshot?: object, createFails = false) {
  const dispose = vi.fn();
  const owner = {
    metadata: async () => ({
      pid: 17,
      credentials: { uid: 1000 },
      residentByteLimit: 104,
      [Symbol.dispose]: dispose,
    }),
    async forkSnapshot() {
      expect(dispose).toHaveBeenCalledOnce();
      if (snapshotFails) throw new Error("snapshot unavailable");
      return snapshot;
    },
  };
  const drain = vi.fn(async () => {});
  const create = vi.fn(() => {
    expect(dispose).toHaveBeenCalledOnce();
    if (createFails) throw new Error("Bash construction failed");
    return { run: async () => exit, drain };
  });
  const source = bashMain("ChildBash")
    .replace(/^import .*;$/gm, "")
    .replace("export class ChildBash", "return class ChildBash");
  const Entry = new Function("WorkerEntrypoint", "module", "createWorkerChildBash", source)(
    Object,
    {},
    create,
  ) as new () => { run(command: unknown, owner: unknown): Promise<typeof exit> };
  return { entry: new Entry(), owner, dispose, drain, create };
}

describe("generated Bash worker metadata ownership", () => {
  it("releases metadata before requesting the snapshot or running Bash", async () => {
    const f = fixture();
    expect(await f.entry.run(command, f.owner)).toEqual(exit);
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 17,
        credentials: { uid: 1000 },
        residentWasmBudgetBytes: 104,
      }),
    );
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.drain).toHaveBeenCalledOnce();
  });

  it("keeps metadata released when requesting the snapshot fails", async () => {
    const f = fixture(true);
    await expect(f.entry.run(command, f.owner)).rejects.toThrow("snapshot unavailable");
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("releases metadata when reading its fields fails", async () => {
    const f = fixture();
    f.owner.metadata = async () => ({
      get pid(): number {
        throw new Error("invalid metadata");
      },
      credentials: { uid: 1000 },
      residentByteLimit: 104,
      [Symbol.dispose]: f.dispose,
    });
    await expect(f.entry.run(command, f.owner)).rejects.toThrow("invalid metadata");
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("releases the snapshot if Bash construction fails before taking ownership", async () => {
    const dispose = vi.fn();
    const f = fixture(false, { [Symbol.dispose]: dispose }, true);
    await expect(f.entry.run(command, f.owner)).rejects.toThrow("Bash construction failed");
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.drain).not.toHaveBeenCalled();
  });
});
