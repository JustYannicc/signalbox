import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";
import {
  CHILD_COREUTILS_COMMANDS,
  CHILD_PROGRAM_PATHS,
} from "../../src/computer/ChildProgramSet.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_GIT_ARTIFACT } from "../../src/kernel/KernelGitProgram.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../src/kernel/KernelGnuPrograms.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { readPinnedProgram } from "./measured.ts";
import {
  createChildProgramExecutableCatalog,
  prepareChildPrograms,
  type FullChildProgramSources,
} from "./prepare.ts";
import { packageGraph } from "./packageGraph.ts";
import {
  createGitTemplateDataCatalog,
  readPinnedGitTemplates,
  verifyGitTemplateDataFile,
} from "./gitTemplates.ts";
import { createSeededCommandProgramCodes } from "./runtime.ts";
import { bashMain, busyboxMain, measuredProgramMain, ripgrepMain } from "./workerEntrypoints.ts";
import coreutilsProvenance from "../kernelPrograms/coreutils/provenance.json" with { type: "json" };

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const encoder = new TextEncoder();

describe("full child program preparation", () => {
  it("packages source graphs for each public child program", async () => {
    const cloudRoot = NodePath.resolve(import.meta.dirname, "../..");
    const sources = new Map();
    const programs = [
      ["src/computer/ChildBash.ts", "ChildBash", bashMain],
      ["src/computer/ChildBusybox.ts", "ChildBusybox", busyboxMain],
      ["src/computer/ChildWasi.ts", "ChildRipgrep", ripgrepMain],
      ["src/computer/ChildCoreutils.ts", "ChildCoreutils", measuredProgramMain("Coreutils")],
      ["src/computer/ChildGit.ts", "ChildGit", measuredProgramMain("Git")],
    ] as const;
    const graphs = await Promise.all(
      programs.map(([sourcePath, entrypoint, mainSource]) =>
        packageGraph(cloudRoot, sourcePath, entrypoint, mainSource, sources),
      ),
    );
    expect(graphs.map(({ code }) => code.entrypoint)).toEqual(
      programs.map(([, entrypoint]) => entrypoint),
    );
    expect([...sources.keys()]).toEqual(expect.arrayContaining(programs.map(([path]) => path)));
    expect(
      graphs.every(({ code }) => {
        const main = code.modules[code.mainModule];
        return (
          typeof main === "object" &&
          main !== null &&
          "js" in main &&
          main.js.includes("program.wasm")
        );
      }),
    ).toBe(true);
  });

  it("rejects unpinned base artifacts before preparing the full catalog", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "child-program-artifacts-"));
    try {
      await Promise.all(
        ["bash.wasm", "busybox.wasm", "rg.wasm"].map((name) =>
          NodeFSP.writeFile(NodePath.join(root, name), encoder.encode(name)),
        ),
      );
      await expect(prepareChildPrograms({ programDir: root })).rejects.toThrow(
        "Pinned child program does not match",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("requires and pins all programs for CommandProgramCodes", async () => {
    const programs = fullProgramSources();
    const codes = createSeededCommandProgramCodes(programs);
    expect(Object.keys(codes.coreutils ?? {})).toEqual([...CHILD_COREUTILS_COMMANDS]);
    expect(await programReference(codes.bash)).toBe(KERNEL_BASH_ARTIFACT.sha256);
    expect(await programReference(codes.busyboxCat)).toBe(KERNEL_BUSYBOX_ARTIFACT.sha256);
    expect(await programReference(codes.busyboxApplets)).toBe(KERNEL_BUSYBOX_ARTIFACT.sha256);
    expect(await programReference(codes.ripgrep)).toBe(KERNEL_RIPGREP_ARTIFACT.sha256);
    expect(await programReference(codes.git)).toBe(KERNEL_GIT_ARTIFACT.sha256);
    expect(await programReference(codes.sed)).toBe(KERNEL_GNU_SED_ARTIFACT.sha256);
    for (const command of CHILD_COREUTILS_COMMANDS) {
      expect(await programReference(codes.coreutils![command])).toBe(
        coreutilsProvenance.commands[command].sha256,
      );
    }

    const { mkdir: _missing, ...incompleteCoreutils } = programs.coreutils;
    expect(() =>
      createSeededCommandProgramCodes({
        ...programs,
        coreutils: incompleteCoreutils,
      } as unknown as FullChildProgramSources),
    ).toThrow("Prepared child program is missing coreutils mkdir");
  });

  it("describes each of the 18 executable paths and rejects incomplete seeds", () => {
    const files = Object.values(CHILD_PROGRAM_PATHS).map((path, index) => ({
      path,
      bytes: encoder.encode(path),
      sha256: String(index).padStart(64, "0"),
      mode: 0o755 as const,
    }));
    const catalog = createChildProgramExecutableCatalog(files);
    expect(Object.keys(catalog)).toEqual(Object.values(CHILD_PROGRAM_PATHS));
    expect(Object.keys(catalog)).toHaveLength(18);
    expect(catalog["/bin/sed"]).toEqual({
      bytes: encoder.encode("/bin/sed").byteLength,
      sha256: String(Object.values(CHILD_PROGRAM_PATHS).indexOf("/bin/sed")).padStart(64, "0"),
      mode: 0o755,
    });
    expect(() => createChildProgramExecutableCatalog(files.slice(1))).toThrow(
      "Prepared child executables do not cover the full command catalog",
    );
    expect(() => createChildProgramExecutableCatalog([...files, files[0]!])).toThrow(
      "Prepared child executables do not cover the full command catalog",
    );
  });

  it("checks pinned executable bytes before recording them", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "child-program-pin-"));
    const bytes = encoder.encode("small immutable wasm stand-in");
    const sha256 = digest(bytes);
    try {
      await NodeFSP.writeFile(NodePath.join(root, "coreutils"), bytes);
      const artifacts = new Map();
      const read = await readPinnedProgram(
        root,
        "coreutils",
        { bytes: bytes.byteLength, sha256 },
        artifacts,
      );
      expect(read).toEqual({ bytes, sha256 });
      expect(artifacts.get("coreutils")).toEqual({
        path: "coreutils",
        bytes: bytes.byteLength,
        sha256,
      });
      await expect(
        readPinnedProgram(
          root,
          "coreutils",
          { bytes: bytes.byteLength, sha256: "0".repeat(64) },
          new Map(),
        ),
      ).rejects.toThrow("Pinned child program does not match coreutils");
      await expect(
        readPinnedProgram(root, "coreutils", { bytes: bytes.byteLength + 1, sha256 }, new Map()),
      ).rejects.toThrow("Pinned child program does not match coreutils");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("checks Git template seed data and refuses to omit the template tree", async () => {
    const bytes = encoder.encode("template\n");
    const sha256 = digest(bytes);
    const descriptor = verifyGitTemplateDataFile(
      {
        path: "/usr/share/git-core/templates/description",
        bytes: bytes.byteLength,
        sha256,
        mode: 0o644,
      },
      bytes,
      { isFile: true, mode: 0o644 },
    );
    const catalog = createGitTemplateDataCatalog([descriptor]);
    expect(catalog[descriptor.path]).toEqual({ bytes: bytes.byteLength, sha256, mode: 0o644 });
    expect(() =>
      verifyGitTemplateDataFile(
        {
          path: descriptor.path,
          bytes: descriptor.bytes.byteLength,
          sha256: "0".repeat(64),
          mode: descriptor.mode,
        },
        bytes,
        { isFile: true, mode: 0o644 },
      ),
    ).toThrow(`Pinned Git template changed at ${descriptor.path}`);

    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "child-program-templates-"));
    try {
      await expect(readPinnedGitTemplates(root)).rejects.toThrow(
        "Pinned Git template assets are missing",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

function fullProgramSources(): FullChildProgramSources {
  const coreutils = Object.fromEntries(
    CHILD_COREUTILS_COMMANDS.map((command) => [command, code(command)]),
  ) as unknown as FullChildProgramSources["coreutils"];
  return {
    bash: code("bash"),
    busyboxCat: code("busybox-cat"),
    busyboxApplets: code("busybox-applets"),
    sed: code("gnu-sed"),
    ripgrep: code("ripgrep"),
    coreutils,
    git: code("git"),
  };
}

function code(entrypoint: string) {
  return { mainModule: "main.js", entrypoint, modules: { "main.js": "export default {};" } };
}

async function programReference(code: ChildWorkerCode): Promise<string | undefined> {
  const modules = typeof code.modules === "function" ? await code.modules() : code.modules;
  const reference = modules["program.wasm"];
  return typeof reference === "object" && reference !== null && "wasmReference" in reference
    ? reference.wasmReference
    : undefined;
}

function digest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
