// @effect-diagnostics nodeBuiltinImport:off - reads a locally staged, hash-pinned Git module.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { KERNEL_GIT_ARTIFACT } from "../../kernel/KernelGitProgram.ts";
import type { KernelGitCall } from "../../kernel/KernelGitPort.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { createChildGit } from "../ChildGit.ts";
import { childGitFixture, exited, text } from "./ChildGitFixture.ts";

const artifact =
  NodeProcess.env.SIGNALBOX_GIT_ARTIFACT_PATH ??
  new URL("../../../../../.t3/issue-1263/programs/git.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_GIT_ARTIFACT === "1")
  throw new Error("SIGNALBOX_REQUIRE_GIT_ARTIFACT=1 requires .t3/issue-1263/programs/git.wasm");

let gitModule: WebAssembly.Module | undefined;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.byteLength !== KERNEL_GIT_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_GIT_ARTIFACT.sha256
  )
    throw new Error("Git test artifact does not match its pin");
  gitModule = new WebAssembly.Module(bytes);
}

describe.skipIf(!available)("actual pinned Git child", () => {
  it("uses the prepared cwd to read a file and writes its canonical object into that repository", async () => {
    const content = "child heap, parent-owned files\n";
    const fixture = childGitFixture({
      args: ["git", "hash-object", "-w", "input.txt"],
    });
    fixture.filesystem.mkdir("/workspace/repo");
    fixture.filesystem.mkdir("/workspace/repo/.git");
    fixture.filesystem.mkdir("/workspace/repo/.git/objects");
    fixture.filesystem.mkdir("/workspace/repo/.git/refs");
    fixture.filesystem.mkdir("/workspace/repo/.git/refs/heads");
    fixture.write("/workspace/repo/.git/HEAD", "ref: refs/heads/main\n");
    fixture.write(
      "/workspace/repo/.git/config",
      "[core]\n repositoryformatversion = 0\n filemode = true\n bare = false\n",
    );
    fixture.write("/workspace/repo/input.txt", content);
    fixture.filesystem.chdir("/workspace/repo");
    const requests: (KernelSyscallRequest | KernelGitCall)[] = [];
    const port = {
      async call(request: KernelSyscallRequest) {
        requests.push(request);
        return fixture.owner.port.call(structuredClone(request));
      },
      async callGit(request: KernelGitCall) {
        requests.push(request);
        return fixture.owner.port.callGit(structuredClone(request));
      },
    };
    try {
      expect(
        await createChildGit({
          module: gitModule!,
          port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run(),
      ).toEqual(exited());

      const oid = NodeCrypto.createHash("sha1")
        .update(`blob ${text(content).byteLength}\0`)
        .update(content)
        .digest("hex");
      expect(new TextDecoder().decode(fixture.stdout()).trim()).toBe(oid);
      const object = fixture.read(
        `/workspace/repo/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
      );
      expect(NodeZlib.inflateSync(object)).toEqual(
        Buffer.concat([Buffer.from(`blob ${text(content).byteLength}\0`), Buffer.from(content)]),
      );
      expect(fixture.filesystem.cwd).toBe("/workspace/repo");
      expect(fixture.stderr()).toBe("");
      expect(requests.some((request) => request.name === "fd_read")).toBe(true);
      expect(requests.some((request) => request.name === "fd_write")).toBe(true);
      for (const request of requests) {
        const copied = request.regions.reduce((size, region) => size + region.bytes.byteLength, 0);
        expect(copied).toBeLessThan(request.memorySize);
      }
    } finally {
      await fixture.close();
    }
  });
});
