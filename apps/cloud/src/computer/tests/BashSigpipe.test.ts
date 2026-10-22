// @effect-diagnostics nodeBuiltinImport:off - compares pinned local WASM with a native Bash oracle.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT, createKernelBashProgram } from "../../kernel/KernelBashProgram.ts";
import { createKernelCoreutilsProgram } from "../../kernel/KernelCoreutilsPrograms.ts";
import { createKernelCoreutilsHost } from "../../kernel/KernelCoreutilsHost.ts";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";
import { coreutilsArtifactsAvailable, coreutilsModule } from "./CoreutilsArtifactFixture.ts";

const bashPath = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const bashAvailable = NodeFS.existsSync(bashPath);
if (
  (!bashAvailable || !coreutilsArtifactsAvailable) &&
  process.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1"
)
  throw new Error("SIGPIPE tests require the pinned Bash and coreutils head artifacts");

function bashModule() {
  const bytes = NodeFS.readFileSync(bashPath);
  expect(bytes.length).toBe(KERNEL_BASH_ARTIFACT.bytes);
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
    KERNEL_BASH_ARTIFACT.sha256,
  );
  return new WebAssembly.Module(bytes);
}

function program(fixture: ReturnType<typeof childBashFixture>, child: boolean) {
  const module = bashModule();
  return child
    ? createChildBash({
        module,
        credentials: bashCredentials,
        pid: fixture.owner.pid,
        port: fixture.owner.port,
        args: fixture.context.args,
        env: fixture.context.env,
      })
    : createKernelBashProgram({ module, credentials: bashCredentials });
}

describe.skipIf(!bashAvailable || !coreutilsArtifactsAvailable)("GNU Bash SIGPIPE", () => {
  it.each([false, true])(
    "terminates Bash with SIGPIPE before its next command, child=%s",
    async (child) => {
      const fixture = childBashFixture({
        args: ["bash", "--noprofile", "--norc", "-c", "printf y; printf survived >&2"],
      });
      const pipe = new KernelPipe(fixture.wakes);
      pipe.closeReader();
      const stdout = fixture.filesystem.descriptors.get(1).stdio;
      if (!stdout?.write) throw new Error("Missing stdout");
      vi.spyOn(stdout, "write").mockImplementation((bytes) => pipe.write(bytes));
      try {
        expect(await program(fixture, child).run(fixture.context)).toEqual({
          exitCode: 0,
          signal: 13,
          coreDumped: false,
        });
        expect(fixture.stderr()).toBe("");
      } finally {
        await fixture.close();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("finishes an unbounded builtin pipeline, child=%s pipefail=%s", async (child, pipefail) => {
    const count = 131_073;
    const command = `${pipefail ? "set -o pipefail; " : ""}while :; do printf y; done | head -c ${count}; printf '%s:%s\\n' "$?" "\${PIPESTATUS[*]}" >&2`;
    const native = NodeChildProcess.spawnSync("/bin/bash", [
      "--noprofile",
      "--norc",
      "-c",
      command,
    ]);
    expect(native.error).toBeUndefined();
    expect(native.status).toBe(0);
    expect(native.stdout.byteLength).toBe(count);
    expect(native.stderr.toString()).toBe(`${pipefail ? 141 : 0}:141 0\n`);
    const head = coreutilsModule("head");
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "-c", command],
      async exec(request) {
        expect(request.path).toBe("/bin/head");
        expect(request.identity.pid).not.toBe(fixture.context.identity.pid);
        const context = { ...fixture.context, ...request };
        if (!child) return createKernelCoreutilsProgram(head).run(context);
        const owner = createKernelCoreutilsHost({ context });
        try {
          return await createChildCoreutils({
            module: head,
            port: owner.port,
            args: request.args,
            env: request.env,
          }).run();
        } finally {
          await owner.close();
        }
      },
    });
    fixture.write("/bin/head", "", 0o755);
    const stderr = fixture.filesystem.descriptors.get(2).stdio;
    if (!stderr?.write) throw new Error("Missing stderr");
    const write = stderr.write.bind(stderr);
    let errors = 0;
    vi.spyOn(stderr, "write").mockImplementation((bytes, flags) => {
      // Bound the known failure by observed writes, so a red run cannot spin forever.
      if (new TextDecoder().decode(bytes).includes("Broken pipe") && ++errors > 1)
        throw new Error("Bash continued after a second broken-pipe write");
      return write(bytes, flags);
    });
    try {
      expect(await program(fixture, child).run(fixture.context)).toEqual(exited());
      expect(fixture.stdoutBytes()).toEqual(new Uint8Array(native.stdout));
      expect(fixture.stderr()).toBe(native.stderr.toString());
      expect(fixture.processes.size).toBe(1);
      expect(fixture.wakes.size).toBe(0);
    } finally {
      await fixture.close();
      vi.restoreAllMocks();
    }
  });
});
