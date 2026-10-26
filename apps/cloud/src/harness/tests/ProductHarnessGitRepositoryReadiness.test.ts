// @effect-diagnostics nodeBuiltinImport:off - A child Node process enables the pinned Git JSPI module.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { expect, it, onTestFinished } from "vite-plus/test";

const artifact =
  NodeProcess.env.SIGNALBOX_GIT_ARTIFACT_PATH ??
  NodePath.resolve(import.meta.dirname, "../../../../../.t3/issue-1263/programs/git.wasm");

it.skipIf(!NodeFS.existsSync(artifact))(
  "runs the public ProductHost Git gate through pinned refresh, machine rules, failure and cancellation",
  async () => {
    for (const scenario of [
      "repository-readiness",
      "repository-machine-rule",
      "repository-failure",
      "repository-cancel",
    ] as const) {
      const child = NodeChildProcess.execFile(NodeProcess.execPath, [
        "--experimental-wasm-jspi",
        "--experimental-vm-modules",
        NodeURL.fileURLToPath(new URL("./productHost/repositoryProcess.ts", import.meta.url)),
        scenario,
      ]);
      onTestFinished(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGTERM");
        });
      });
      const { stdout, stderr } = child;
      if (stdout === null || stderr === null)
        throw new Error("ProductHost child output streams are unavailable");
      const output = await new Promise<string>((resolve, reject) => {
        const chunks: string[] = [];
        const errors: string[] = [];
        stdout.setEncoding("utf8");
        stderr.setEncoding("utf8");
        stdout.on("data", (chunk: string) => chunks.push(chunk));
        stderr.on("data", (chunk: string) => errors.push(chunk));
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0)
            reject(new Error(`ProductHost ${scenario} exited ${code}: ${errors.join("")}`));
          else resolve(chunks.join(""));
        });
      });
      expect(JSON.parse(output)).toEqual({ ok: true });
    }
  },
);
