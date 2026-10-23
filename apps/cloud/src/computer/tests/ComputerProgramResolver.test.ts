import { describe, expect, it, vi } from "vite-plus/test";
import type { ResolvedProgram } from "../../kernel/KernelAbi.ts";
import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { KernelProgramAdmissionRequest } from "../../kernel/KernelProgramAdmission.ts";
import type { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import {
  ComputerProgramResolver,
  type ComputerProgramResolverRequest,
} from "../ComputerProgramResolver.ts";

interface FileRecord {
  readonly type: "file" | "directory";
  readonly executable: boolean;
  readonly lower: boolean;
}

const command = (
  executable: string,
  options: {
    readonly cwd?: string;
    readonly path?: string;
    readonly signal?: AbortSignal;
    readonly filesystem?: KernelFileSystem;
  } = {},
) => {
  const cwd = options.cwd ?? "/workspace";
  return {
    kind: "command" as const,
    stdio: "piped" as const,
    command: {
      executable,
      argv: [executable],
      cwd,
      env: { PATH: options.path ?? "/workspace/bin:/usr/bin", HOME: "/workspace" },
    },
    baseCwd: cwd,
    actions: [],
    attributes: undefined,
    filesystem: options.filesystem ?? ({} as KernelFileSystem),
    processes: {} as KernelProcessTable,
    signal: options.signal ?? new AbortController().signal,
    target: {
      kind: "unsupported" as const,
      code: "NOT_FOUND" as const,
      message: "Command not found",
    },
  } satisfies KernelProgramAdmissionRequest;
};

function resolverFor(files: Readonly<Record<string, FileRecord>>) {
  const requested: string[][] = [];
  const lower = new Set(
    Object.entries(files)
      .filter(([, file]) => file.lower)
      .map(([path]) => path),
  );
  const filesystem = {
    async checkExecutable(path: string) {
      const file = files[path];
      if (file === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (!file.executable) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return { type: file.type };
    },
  } as unknown as KernelFileSystem;
  const prepare = vi.fn(async (paths: readonly string[]) => {
    requested.push([...paths]);
  });
  const isLower = vi.fn(async (path: string) => lower.has(path));
  return {
    resolver: new ComputerProgramResolver({
      path: ["/workspace/bin", "/usr/bin"],
      overlay: { prepare, isLower },
    }),
    filesystem,
    requested,
    prepare,
    isLower,
  };
}

const catalogBinding = {} as KernelProgramBinding;
const bindings = new Map([[CHILD_PROGRAM_PATHS.bash, catalogBinding]]);
const withCatalog = (
  request: KernelProgramAdmissionRequest,
  catalog: ReadonlyMap<string, KernelProgramBinding> = new Map(),
): ComputerProgramResolverRequest => ({ ...request, catalog });

describe("ComputerProgramResolver", () => {
  it("checks PATH in order and returns the selected lower-machine catalog alias", async () => {
    const fixture = resolverFor({
      "/workspace/bin/bash": { type: "file", executable: true, lower: true },
      "/usr/bin/bash": { type: "file", executable: true, lower: true },
    });
    const request = command("bash", {
      path: "/workspace/bin:/usr/bin",
      filesystem: fixture.filesystem,
    });

    const input = withCatalog(request, bindings);
    const result = await fixture.resolver.resolve(input);

    expect(fixture.requested).toEqual([["/workspace/bin/bash"]]);
    expect(result.command.executable).toBe("/workspace/bin/bash");
    expect(input.command).toBe(request.command);
    expect(input.catalog).toBe(bindings);
    expect(result.catalog).toEqual({
      command: { ...request.command, executable: CHILD_PROGRAM_PATHS.bash },
      binding: catalogBinding,
    });
  });

  it("uses an explicit machine-only path without consulting PATH", async () => {
    const fixture = resolverFor({
      "/home/node/.local/bin/review_late": { type: "file", executable: true, lower: true },
      "/workspace/bin/review_late": { type: "file", executable: true, lower: true },
    });
    const request = command("/home/node/.local/bin/review_late", {
      filesystem: fixture.filesystem,
    });

    const result = await fixture.resolver.resolve(withCatalog(request));

    expect(fixture.requested).toEqual([["/home/node/.local/bin/review_late"]]);
    expect(result.command.executable).toBe("/home/node/.local/bin/review_late");
    expect(result.catalog).toBeUndefined();
  });

  it("lets an executable upper-layer shadow take precedence over a catalog alias", async () => {
    const fixture = resolverFor({
      "/workspace/bin/bash": { type: "file", executable: true, lower: false },
      "/usr/bin/bash": { type: "file", executable: true, lower: true },
    });

    await expect(
      fixture.resolver.resolve(
        withCatalog(command("bash", { filesystem: fixture.filesystem }), bindings),
      ),
    ).rejects.toMatchObject({
      name: "KernelProgramExecAdmissionError",
      code: "ENOEXEC",
    });
    expect(fixture.isLower).toHaveBeenCalledTimes(1);
    expect(fixture.isLower).toHaveBeenCalledWith("/workspace/bin/bash", expect.any(AbortSignal));
  });

  it("distinguishes a permission-denied PATH match from a fresh miss", async () => {
    const denied = resolverFor({
      "/workspace/bin/tool": { type: "file", executable: false, lower: false },
    });
    const missing = resolverFor({});

    await expect(
      denied.resolver.resolve(
        withCatalog(command("tool", { path: "/workspace/bin", filesystem: denied.filesystem })),
      ),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      missing.resolver.resolve(
        withCatalog(command("typo", { path: "/workspace/bin", filesystem: missing.filesystem })),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing.requested).toEqual([["/workspace/bin/typo"]]);
  });

  it("continues PATH search after a denied candidate", async () => {
    const fixture = resolverFor({
      "/workspace/bin/tool": { type: "file", executable: false, lower: true },
      "/usr/bin/tool": { type: "file", executable: true, lower: true },
    });
    fixture.prepare.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const result = await fixture.resolver.resolve(
      withCatalog(command("tool", { filesystem: fixture.filesystem })),
    );
    expect(result.command.executable).toBe("/usr/bin/tool");
  });

  it("preserves an already-resolved local program without querying machine state", async () => {
    const fixture = resolverFor({});
    const request = {
      ...command("/bin/sort"),
      target: {
        kind: "resolved" as const,
        program: {} as unknown as ResolvedProgram,
        binding: catalogBinding,
      },
    } as KernelProgramAdmissionRequest;

    const result = await fixture.resolver.resolve(withCatalog(request, bindings));

    expect(result.command).toBe(request.command);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
});
