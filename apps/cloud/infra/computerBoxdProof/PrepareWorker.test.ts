// @effect-diagnostics nodeBuiltinImport:off - temporary build output verifies validation cannot replace a recovery bundle.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { prepareProofWorker } from "./PrepareWorker.ts";
import type { ProofSeed } from "./SeedProtocol.ts";

const files: ProofSeed["executables"] = [
  { path: "/bin/bash", data: "", sha256: KERNEL_BASH_ARTIFACT.sha256 },
  { path: "/bin/cat", data: "", sha256: KERNEL_BUSYBOX_ARTIFACT.sha256 },
  { path: "/bin/rg", data: "", sha256: KERNEL_RIPGREP_ARTIFACT.sha256 },
];
const code = { mainModule: "main.js", modules: { "main.js": "export default {}" } };
const seed: ProofSeed = {
  sourceCommit: "a".repeat(40),
  runner: { source: "runner", sha256: "b".repeat(64) },
  programs: { bash: code, busyboxCat: code, ripgrep: code },
  executables: files,
};

describe("proof static worker packaging", () => {
  it.each([
    { name: "missing pin", executables: files.slice(1) },
    { name: "duplicate pin", executables: [files[0]!, files[0]!, files[2]!] },
    {
      name: "wrong identity",
      executables: files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
    },
    { name: "corrupt bytes", executables: files },
  ])("preserves a recovery bundle on $name", async ({ executables }) => {
    const outputDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "boxd-proof-build-"),
    );
    const entryPoint = NodePath.join(outputDirectory, "worker.js");
    try {
      await NodeFSP.writeFile(entryPoint, "retained recovery bundle");
      await expect(
        prepareProofWorker({ seed: { ...seed, executables }, outputDirectory }),
      ).rejects.toThrow();
      expect(await NodeFSP.readFile(entryPoint, "utf8")).toBe("retained recovery bundle");
      expect(await NodeFSP.readdir(outputDirectory)).toEqual(["worker.js"]);
    } finally {
      await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
