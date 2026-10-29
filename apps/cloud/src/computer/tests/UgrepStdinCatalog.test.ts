// @effect-diagnostics nodeBuiltinImport:off - reads only the pinned ugrep artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { commandGatewayFixture, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

import { capturedGrepCases as cases, grepInputLines as lines } from "./GrepStdinFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const prefix = [
  "ugrep",
  "-G",
  "--ignore-files",
  "--hidden",
  "-I",
  "--exclude-dir=.git",
  "--exclude-dir=.svn",
  "--exclude-dir=.hg",
  "--exclude-dir=.bzr",
  "--exclude-dir=.jj",
  "--exclude-dir=.sl",
] as const;
const command = (args: readonly string[]) => ({
  executable: "/usr/local/bin/claude",
  argv: [...prefix, ...args],
  cwd: "/work",
  env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
});

const artifact =
  NodeProcess.env.SIGNALBOX_UGREP_ARTIFACT ??
  new URL("../../../../../.t3/1071/programs/ugrep.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_UGREP_ARTIFACT === "1")
  throw new Error("The ugrep catalog test requires the pinned WASI artifact");
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_UGREP_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_UGREP_ARTIFACT.sha256
  )
    throw new Error("The ugrep catalog artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

describe.skipIf(!available)("pinned ugrep through the public command gateway", () => {
  async function run(args: readonly string[]) {
    const dispatched: { executable: string; argv: readonly string[] }[] = [];
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        dispatched.push({ executable: input.command.executable, argv: input.command.argv });
        try {
          return await createChildBusybox({
            module,
            port: await invocation.host<KernelBusyboxPort>(),
            args: input.command.argv,
            env: input.command.env,
          }).run();
        } finally {
          invocation.acknowledge();
        }
      },
    });
    fixture.filesystem.mkdir("/work");
    try {
      const input = command(args);
      const child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          readAll(child.stdout),
          readAll(child.stderr),
          (async () => {
            const writer = child.stdin.getWriter();
            try {
              const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
              const split = bytes.indexOf(0xe9) + 1;
              await writer.write(bytes.subarray(0, split));
              await writer.write(bytes.subarray(split));
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          })(),
        ]);
        await fixture.gateway.drain();
        expect(fixture.machineSpawn).not.toHaveBeenCalled();
        expect(dispatched).toEqual([{ executable: input.executable, argv: input.argv }]);
        expect(fixture.capacity.active).toBe(0);
        return {
          status,
          stdout: new TextDecoder().decode(stdout),
          stderr: new TextDecoder().decode(stderr),
        };
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.close();
    }
  }

  it.each(cases)("runs $name without a machine", async ({ args, expected }) => {
    const result = await run(args);
    expect(result).toEqual({ status: exited(), stdout: expected, stderr: "" });
  });

  it("returns status 1 for no matches", async () => {
    expect(await run(["-E", "does-not-match-any-line"])).toEqual({
      status: exited(1),
      stdout: "",
      stderr: "",
    });
  });

  it("catches a real regex exception and returns status 2", async () => {
    const result = await run(["-E", "["]);
    expect(result.status).toEqual(exited(2));
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mismatched [ ]");
  });
});
