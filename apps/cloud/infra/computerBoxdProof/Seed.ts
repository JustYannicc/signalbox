// @effect-diagnostics nodeBuiltinImport:off - packages immutable proof inputs before deployment.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { prepareChildPrograms } from "../childPrograms/prepare.ts";
import { preflightTrustedRunnerArtifact } from "./privateRunnerArtifact.ts";
import type { ProofSeed } from "./SeedProtocol.ts";

export async function prepareProofSeed(programDir: string): Promise<ProofSeed> {
  const root = NodePath.resolve(import.meta.dirname, "../../../..");
  const sourceCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (
    NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  ) {
    throw new Error("Commit the proof candidate before packaging inputs");
  }
  const prepared = await prepareChildPrograms({ programDir });
  const runner = await NodeFSP.readFile(
    NodePath.resolve(root, "apps/server/dist/command-runner/command-runner.mjs"),
  );
  await preflightTrustedRunnerArtifact(runner, root);
  return {
    sourceCommit,
    runner: {
      source: runner.toString("utf8"),
      sha256: NodeCrypto.createHash("sha256").update(runner).digest("hex"),
    },
    programs: { bash: prepared.bash, busyboxCat: prepared.busyboxCat, ripgrep: prepared.ripgrep },
    executables: prepared.executableFiles.map((file) => ({
      path: file.path,
      data: Buffer.from(file.bytes).toString("base64"),
      sha256: file.sha256,
    })),
  };
}
