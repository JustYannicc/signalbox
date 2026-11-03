// @effect-diagnostics nodeBuiltinImport:off - this test owns native temporary files and children.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { makeRunnerExecProcessHost } from "./RunnerExecProcessHost.ts";

it.each([0, 5, 64])(
  "reopens a regular file at fd 3 and offset %s in a native child",
  async (offset) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-inherited-fd-"));
    const path = NodePath.join(root, "target");
    NodeFS.writeFileSync(path, "skip:single-file grep\n");
    try {
      const child = makeRunnerExecProcessHost().spawn(
        {
          type: "start",
          generation: 1,
          requestId: "start",
          processId: "child",
          executable: process.execPath,
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(require('node:fs').readFileSync(3))",
          ],
          cwd: root,
          env: {},
          inheritedFds: [{ childFd: 3, path, flags: 0, offset }],
        },
        root,
      );
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.stdin.end();
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(Buffer.concat(errors).toString()).toBe("");
      expect(status).toBe(0);
      expect(Buffer.concat(chunks).toString()).toBe("skip:single-file grep\n".slice(offset));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["missing", "directory"])("fails clearly when an inherited path is %s", (kind) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-fd-error-"));
  try {
    expect(() =>
      makeRunnerExecProcessHost().spawn(
        {
          type: "start",
          generation: 1,
          requestId: "start",
          processId: "child",
          executable: process.execPath,
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: root,
          env: {},
          inheritedFds: [
            {
              childFd: 3,
              path: kind === "missing" ? NodePath.join(root, "missing") : root,
              flags: 0,
              offset: 0,
            },
          ],
        },
        root,
      ),
    ).toThrow("Cannot reopen inherited fd 3");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
