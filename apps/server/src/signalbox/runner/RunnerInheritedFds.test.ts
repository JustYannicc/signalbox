// @effect-diagnostics nodeBuiltinImport:off - this test owns native temporary files and children.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { withRunnerInheritedFds } from "./RunnerInheritedFds.ts";
import { driveFileSystem } from "./RunnerInheritedFds.fixture.ts";
import { makeRunnerExecProcessHost } from "./RunnerExecProcessHost.ts";

it.each([0])("reopens a regular file at fd 3 and offset %s in a native child", async (offset) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-inherited-fd-"));
  const path = NodePath.join(root, "target");
  NodeFS.writeFileSync(path, "skip:single-file grep\n");
  try {
    const child = makeRunnerExecProcessHost({ inheritedFiles: driveFileSystem(root) }).spawn(
      {
        type: "start",
        generation: 1,
        requestId: "start",
        processId: "child",
        executable: process.execPath,
        argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync(3))"],
        cwd: root,
        env: {},
        inheritedFds: [{ childFd: 3, path: "/workspace/target", flags: 0, offset: 0 }],
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
});

it.each(["missing", "directory"])("fails clearly when an inherited path is %s", (kind) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-fd-error-"));
  NodeFS.mkdirSync(NodePath.join(root, "sub"));
  try {
    expect(() =>
      makeRunnerExecProcessHost({ inheritedFiles: driveFileSystem(root) }).spawn(
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
              path: kind === "missing" ? "/workspace/missing" : "/workspace/sub",
              flags: 0,
              offset: 0,
            },
          ],
        },
        root,
      ),
    ).toThrow(
      kind === "directory"
        ? "Inherited file is not a regular file"
        : "Cannot reopen inherited fd 3",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["parent", "host", "symlink", "replaced", "opened-escape", "offset"])(
  "refuses an inherited %s escape or unsupported file",
  (kind) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-drive-"));
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-outside-"));
    try {
      NodeFS.writeFileSync(NodePath.join(root, "target"), "Drive bytes");
      NodeFS.writeFileSync(NodePath.join(outside, "target"), "host bytes");
      NodeFS.symlinkSync(NodePath.join(outside, "target"), NodePath.join(root, "escape"));
      const files = driveFileSystem(root);
      const checked =
        kind === "replaced"
          ? { ...files, stat: () => NodeFS.statSync(NodePath.join(outside, "target")) }
          : kind === "opened-escape"
            ? { ...files, readlink: () => NodePath.join(outside, "target") }
            : files;
      const path =
        kind === "parent"
          ? "/workspace/../escape"
          : kind === "host"
            ? NodePath.join(outside, "target")
            : kind === "symlink"
              ? "/workspace/escape"
              : "/workspace/target";
      expect(() =>
        Reflect.apply(withRunnerInheritedFds, undefined, [
          [{ childFd: 3, path, flags: 0, offset: kind === "offset" ? 1 : 0 }],
          () => {
            throw new Error("spawn must not run");
          },
          checked,
        ]),
      ).toThrow(expect.objectContaining({ name: "RunnerInheritedFdError", code: "ENOTSUP" }));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(outside, { recursive: true, force: true });
    }
  },
);
