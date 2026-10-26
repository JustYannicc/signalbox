import { describe, expect, it, vi } from "vite-plus/test";
import { KernelFileSystemUnavailable } from "../../kernel/KernelLowerFileSystem.ts";
import { createComputerMachineFileSystem } from "../ComputerMachineFileSystem.ts";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";

const signal = () => new AbortController().signal;
const source = (files: MachineFilesPort) =>
  createComputerMachineFileSystem({
    inventory: machineInventoryFixture(),
    files,
    signal: signal(),
  });
const dirtyState = { generation: 7, pristine: false, imageDigest: "sha256:inventory-image" };
const generationState = {
  requested: 7,
  current: 7,
  generationAbsent: false,
  pristine: false,
  imageDigest: "sha256:inventory-image",
};

async function failure(operation: () => unknown) {
  let captured: unknown;
  try {
    await operation();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(KernelFileSystemUnavailable);
  return captured;
}

describe("public machine filesystem diagnostics", () => {
  it("keeps the failed batch and attested absence in the ordinary error string", async () => {
    const lookup = vi.fn<MachineFilesPort["lookup"]>();
    const files: MachineFilesPort = {
      current: () => ({
        generation: null,
        generationAbsent: true,
        pristine: false,
        imageDigest: "sha256:inventory-image",
      }),
      markExecuted: async () => {},
      lookup,
    };
    const error = await failure(() => source(files).lookup(["/etc/gitconfig", "/etc"], signal()));
    const context = {
      operations: [
        { operation: "lstat", path: "/etc/gitconfig" },
        { operation: "lstat", path: "/etc" },
      ],
      generationState: {
        requested: null,
        current: null,
        generationAbsent: true,
        pristine: false,
        imageDigest: "sha256:inventory-image",
      },
    };
    expect(error).toMatchObject({ fatal: true, filesystemContext: context });
    expect(String(error)).toContain(JSON.stringify(context));
    expect(error).not.toHaveProperty("code");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the source cause and current generation for a failed live batch", async () => {
    const cause = new MachineFileLookupError("RUNNER_DISCONNECTED", "Runner disconnected");
    const files: MachineFilesPort = {
      current: () => dirtyState,
      markExecuted: async () => {},
      lookup: vi.fn(async () => {
        throw cause;
      }),
    };
    const error = await failure(() => source(files).lookup(["/etc/gitconfig", "/etc"], signal()));
    expect(error).toMatchObject({
      cause,
      fatal: true,
      filesystemContext: {
        operations: [
          { operation: "lstat", path: "/etc/gitconfig" },
          { operation: "lstat", path: "/etc" },
        ],
        generationState,
      },
    });
    expect(String(error)).toContain("/etc/gitconfig");
    expect(String(error)).toContain("/etc");
    expect(String(error)).not.toContain("Runner disconnected");
  });

  it("keeps directory context when a successful response omits child metadata", async () => {
    const files: MachineFilesPort = {
      current: () => dirtyState,
      markExecuted: async () => {},
      lookup: async (input) => ({
        generation: 7,
        results: input.operations.map(({ id }) => ({
          id,
          op: "readdir",
          nextCursor: null,
          entries: [{ name: "gitconfig", type: "file" }],
        })),
      }),
    };
    const error = await failure(() => source(files).readdir("/etc", signal()));
    const context = { operations: [{ operation: "readdir", path: "/etc" }], generationState };
    expect(error).toMatchObject({ fatal: true, filesystemContext: context });
    expect(String(error)).toContain(JSON.stringify(context));
    expect(error).not.toHaveProperty("code");
  });

  it("keeps range context when a successful response has the wrong byte count", async () => {
    const files: MachineFilesPort = {
      current: () => dirtyState,
      markExecuted: async () => {},
      lookup: async (input) => ({
        generation: 7,
        results: input.operations.map(({ id }) => ({
          id,
          op: "readRange",
          offset: 0,
          bytesRead: 2,
          bytesBase64: "AA==",
          eof: true,
        })),
      }),
    };
    const error = await failure(() => source(files).read("/etc/profile", 0n, 2, signal()));
    const context = {
      operations: [{ operation: "readRange", path: "/etc/profile" }],
      generationState,
    };
    expect(error).toMatchObject({ fatal: true, filesystemContext: context });
    expect(String(error)).toContain(JSON.stringify(context));
    expect(error).not.toHaveProperty("code");
  });

  it("keeps the actual ancestor operation when live symlink provenance is invalid", async () => {
    const fileStat = {
      type: "file" as const,
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      size: "0",
      nlink: "1",
      atimeNs: "0",
      mtimeNs: "0",
      ctimeNs: "0",
    };
    const files: MachineFilesPort = {
      current: () => dirtyState,
      markExecuted: async () => {},
      lookup: async (input) => ({
        generation: 7,
        results: input.operations.map((operation) => ({
          id: operation.id,
          op: "lstat",
          stat: { ...fileStat, type: operation.path === "/etc/link" ? "symlink" : "file" },
        })),
      }),
    };
    const error = await failure(() => source(files).lookup(["/etc/link"], signal()));
    const context = { operations: [{ operation: "lstat", path: "/etc" }], generationState };
    expect(error).toMatchObject({ fatal: true, filesystemContext: context });
    expect(String(error)).toContain(JSON.stringify(context));
    expect(error).not.toHaveProperty("code");
  });
});
