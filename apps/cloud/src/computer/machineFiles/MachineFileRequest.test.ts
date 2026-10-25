import { describe, expect, it, vi } from "vite-plus/test";
import { KernelFileSystemUnavailable } from "../../kernel/KernelLowerFileSystem.ts";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";
import { machineFileRequest } from "./MachineFileRequest.ts";

const operations = [
  { id: "config", op: "lstat", path: "/etc/gitconfig" },
  { id: "etc", op: "readdir", path: "/etc", withStat: true },
] as const;

describe("machine file request diagnostics", () => {
  it("keeps the full failed batch and attested absence in the ordinary error string", async () => {
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

    const request = machineFileRequest(files, new AbortController().signal);
    let error: unknown;
    try {
      await request.batch(operations);
    } catch (cause) {
      error = cause;
    }

    const context = {
      operations: [
        { operation: "lstat", path: "/etc/gitconfig" },
        { operation: "readdir", path: "/etc" },
      ],
      generationState: {
        requested: null,
        current: null,
        generationAbsent: true,
        pristine: false,
        imageDigest: "sha256:inventory-image",
      },
    };
    expect(error).toBeInstanceOf(KernelFileSystemUnavailable);
    expect(error).toMatchObject({ fatal: true, filesystemContext: context });
    expect(String(error)).toContain(JSON.stringify(context));
    expect(error).not.toHaveProperty("code");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the source cause and current generation for a failed lookup batch", async () => {
    const cause = new MachineFileLookupError("RUNNER_DISCONNECTED", "Runner disconnected");
    const files: MachineFilesPort = {
      current: () => ({ generation: 7, pristine: false, imageDigest: "sha256:inventory-image" }),
      markExecuted: async () => {},
      lookup: vi.fn(async () => {
        throw cause;
      }),
    };

    let error: unknown;
    try {
      await machineFileRequest(files, new AbortController().signal).batch(operations);
    } catch (failure) {
      error = failure;
    }

    expect(error).toBeInstanceOf(KernelFileSystemUnavailable);
    expect(error).toMatchObject({
      cause,
      fatal: true,
      filesystemContext: {
        operations: [
          { operation: "lstat", path: "/etc/gitconfig" },
          { operation: "readdir", path: "/etc" },
        ],
        generationState: {
          requested: 7,
          current: 7,
          generationAbsent: false,
          pristine: false,
          imageDigest: "sha256:inventory-image",
        },
      },
    });
    expect(String(error)).toContain("/etc/gitconfig");
    expect(String(error)).toContain("/etc");
    expect(String(error)).not.toContain("Runner disconnected");
  });
});
