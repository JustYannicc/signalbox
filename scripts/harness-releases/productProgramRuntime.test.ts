import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { preserveProgramInputFailure, runBuild } from "./productProgramRuntime.ts";

it("reports the bounded child stderr tail and retains the stable failure code", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "program-build-"));
  try {
    let failure: unknown;
    try {
      await runBuild(
        process.execPath,
        [
          "-e",
          "process.stderr.write('early-output\\n' + 'x'.repeat(20000) + '\\ncompiler detail'); process.stdout.write('y'.repeat(20000)); process.exit(9)",
        ],
        root,
        NodePath.join(root, "build.log"),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected build failure", { cause: failure });
    const message = failure.message;
    expect(message).toContain("PRODUCT_PROGRAM_BUILD_FAILED:node:exit=9");
    expect(message).toContain("compiler detail");
    expect(message).not.toContain("early-output");
    expect(message.length).toBeLessThan(17_000);
    await preserveProgramInputFailure(root, failure);
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(root, "failure.json"), "utf8")),
    ).toMatchObject({
      failureCode: "PRODUCT_PROGRAM_BUILD_FAILED:node:exit=9",
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("includes spawn errors when the build command cannot start", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "program-build-"));
  try {
    await expect(
      runBuild(NodePath.join(root, "missing"), [], root, NodePath.join(root, "build.log")),
    ).rejects.toThrow(
      /PRODUCT_PROGRAM_BUILD_FAILED:missing:spawn[\s\S]*ENOENT[\s\S]*no child output/,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("allows successful builds that write warnings to stderr", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "program-build-"));
  try {
    await expect(
      runBuild(
        process.execPath,
        ["-e", "console.error('warning')"],
        root,
        NodePath.join(root, "build.log"),
      ),
    ).resolves.toBeUndefined();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
