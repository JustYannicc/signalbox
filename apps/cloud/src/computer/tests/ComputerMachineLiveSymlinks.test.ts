import { describe, expect, it } from "vite-plus/test";
import type { MachineFileOperationResult } from "@signalbox/runner-protocol/MachineFilesProtocol";
import { createComputerMachineFileSystem } from "../ComputerMachineFileSystem.ts";
import { MachineFileLookupError } from "../MachineFilesPort.ts";
import { liveMachineFileFixture, liveMachineInventory } from "./LiveMachineFileFixture.ts";

function fixture(count = 1) {
  const inventory = liveMachineInventory("/usr", count);
  const test = liveMachineFileFixture(inventory);
  return {
    ...test,
    inventory,
    source: createComputerMachineFileSystem({
      inventory,
      files: test.files,
      signal: test.owner.signal,
    }),
  };
}

describe("Computer live lower symlink ownership", () => {
  it.each(["lookup", "readdir"] as const)(
    "derives physical ownership from live ancestors during %s and retains raw link data",
    async (operation) => {
      const test = fixture();
      const entries =
        operation === "lookup"
          ? await test.source.lookup(["/bin/tool"])
          : await test.source.readdir("/bin");
      expect(entries?.[0]).toMatchObject({
        path: "/bin/tool",
        symlinkParent: "/usr/bin",
        stat: { type: "symlink", size: 0n },
        metadata: { mode: 0o777, uid: 1000, gid: 1000 },
      });
      expect(await test.source.readlink("/bin/tool")).toBe("../share/tool");
      for (const [input] of test.lookup.mock.calls) {
        expect(input.generation).toBe(1);
        expect(input.operations.length).toBeLessThanOrEqual(64);
        expect(
          input.operations.every(({ op }) => ["lstat", "readlink", "readdir"].includes(op)),
        ).toBe(true);
      }
    },
  );

  it("shares ancestor work across bounded metadata batches and directory pages", async () => {
    const test = fixture(130);
    const paths = Array.from({ length: 130 }, (_, index) => `/bin/tool${index}`);
    const found = await test.source.lookup(paths);
    expect(found).toHaveLength(130);
    expect(found.every((entry) => entry?.symlinkParent === "/usr/bin")).toBe(true);
    expect(test.lookup.mock.calls.slice(0, 3).map(([input]) => input.operations.length)).toEqual([
      64, 64, 2,
    ]);
    expect(
      test.lookup.mock.calls
        .flatMap(([input]) => input.operations)
        .filter((operation) => operation.op === "readlink" && operation.path === "/bin"),
    ).toHaveLength(1);
    test.lookup.mockClear();
    expect(await test.source.readdir("/bin")).toHaveLength(130);
    expect(
      test.lookup.mock.calls
        .flatMap(([input]) => input.operations)
        .filter(({ op }) => op === "readdir"),
    ).toHaveLength(2);
    expect(
      test.lookup.mock.calls
        .flatMap(([input]) => input.operations)
        .filter((operation) => operation.op === "readlink" && operation.path === "/bin"),
    ).toHaveLength(1);
  });

  it("does not reuse physical parents after the machine generation changes", async () => {
    const test = fixture();
    expect((await test.source.lookup(["/bin/tool"]))[0]?.symlinkParent).toBe("/usr/bin");
    test.replace(liveMachineInventory("/opt"));
    expect((await test.source.lookup(["/bin/tool"]))[0]?.symlinkParent).toBe("/opt/bin");
    expect((await test.source.readdir("/bin"))?.[0]?.symlinkParent).toBe("/opt/bin");
  });

  it.each(["lookup", "readdir"] as const)(
    "rejects a generation change during required ancestor resolution for %s",
    async (operation) => {
      const test = fixture();
      test.lookup.mockImplementation(async (input, signal) => {
        const result = await test.respond(input, signal);
        if (input.operations.some((entry) => entry.op === "readlink" && entry.path === "/bin"))
          test.changeGeneration();
        return result;
      });
      const run =
        operation === "lookup" ? test.source.lookup(["/bin/tool"]) : test.source.readdir("/bin");
      await expect(run).rejects.toMatchObject({ name: "KernelFileSystemUnavailable" });
      expect(test.lookup.mock.calls.every(([input]) => input.generation === 1)).toBe(true);
    },
  );

  it.each(["owner", "request"] as const)(
    "preserves %s cancellation during the ancestor walk",
    async (scope) => {
      const test = fixture();
      const request = new AbortController();
      const reason = new Error("Controlled ancestor cancellation");
      test.lookup.mockImplementation(async (input, signal) => {
        const result = await test.respond(input, signal);
        if (input.operations.some((entry) => entry.op === "readlink" && entry.path === "/bin"))
          (scope === "owner" ? test.owner : request).abort(reason);
        return result;
      });
      await expect(test.source.lookup(["/bin/tool"], request.signal)).rejects.toBe(reason);
    },
  );

  it.each(["ENOENT", "ENOTDIR", "transport"])(
    "keeps a required ancestor failure %s fatal",
    async (code) => {
      const test = fixture();
      test.lookup.mockImplementation(async (input, signal) => {
        if (
          input.operations.some(
            (operation) => operation.op === "lstat" && operation.path === "/bin",
          )
        ) {
          if (code === "transport")
            throw new MachineFileLookupError(
              "RUNNER_DISCONNECTED",
              "Controlled ancestor disconnect",
            );
          return {
            generation: input.generation,
            results: input.operations.map((operation) => ({
              id: operation.id,
              op: operation.op,
              error: { code, message: "Controlled required parent failure" },
            })),
          };
        }
        return test.respond(input, signal);
      });
      await expect(test.source.lookup(["/bin/tool"])).rejects.toMatchObject({
        name: "KernelFileSystemUnavailable",
      });
    },
  );

  it("retains ordinary permission denial from ancestor lookup", async () => {
    const test = fixture();
    test.lookup.mockImplementation(async (input, signal) => {
      if (
        input.operations.some((operation) => operation.op === "lstat" && operation.path === "/bin")
      )
        return {
          generation: input.generation,
          results: input.operations.map((operation) => ({
            id: operation.id,
            op: operation.op,
            error: { code: "EACCES", message: "Controlled parent denied" },
          })),
        };
      return test.respond(input, signal);
    });
    await expect(test.source.lookup(["/bin/tool"])).rejects.toMatchObject({ code: "EACCES" });
  });

  it("bounds an ancestor symlink loop introduced after the final lstat reply", async () => {
    const test = fixture();
    test.lookup.mockImplementation(async (input, signal) => {
      if (
        input.operations.some(
          (operation) => operation.op === "readlink" && operation.path === "/bin",
        )
      ) {
        return {
          generation: input.generation,
          results: input.operations.map((operation): MachineFileOperationResult => ({
            id: operation.id,
            op: "readlink",
            targetBase64: btoa("/bin"),
          })),
        };
      }
      return test.respond(input, signal);
    });
    await expect(test.source.lookup(["/bin/tool"])).rejects.toMatchObject({ code: "ELOOP" });
    expect(test.lookup.mock.calls).toHaveLength(3);
  });
});
