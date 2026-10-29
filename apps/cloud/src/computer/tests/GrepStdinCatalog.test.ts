// @effect-diagnostics nodeBuiltinImport:off - reads only the pinned BusyBox grep artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { commandGatewayFixture, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

import { capturedGrepCases as cases, grepInputLines as lines } from "./GrepStdinFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = (args: readonly string[]) => ({
  executable: "/usr/bin/grep",
  argv: ["grep", ...args],
  cwd: "/work",
  env: { LC_ALL: "C" },
});

const artifact =
  NodeProcess.env.SIGNALBOX_BUSYBOX_ARTIFACT ??
  new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT === "1")
  throw new Error("The grep catalog test requires the pinned WASI artifact");
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_BUSYBOX_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BUSYBOX_ARTIFACT.sha256
  )
    throw new Error("The grep catalog artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

describe.skipIf(!available)("pinned grep through the public command gateway", () => {
  async function run(
    args: readonly string[],
    source: "stdin" | "file" = "stdin",
    input = lines.join("\n") + "\n",
  ) {
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
      fixture.write("/work/input", input);
      const captured = command(source === "file" ? [...args, "input"] : args);
      const child = await fixture.gateway.exec(captured, fixture.controller.signal, undefined);
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          readAll(child.stdout),
          readAll(child.stderr),
          (async () => {
            const writer = child.stdin.getWriter();
            try {
              const bytes = new TextEncoder().encode(source === "stdin" ? input : "");
              const split = Math.max(1, bytes.indexOf(0xe9) + 1);
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
        expect(dispatched).toEqual([{ executable: "/bin/grep", argv: captured.argv }]);
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

  it.each(cases.filter(({ args }) => args[0]?.includes("E")))(
    "runs $name against a file",
    async ({ args, expected }) => {
      expect(await run(args, "file")).toEqual({ status: exited(), stdout: expected, stderr: "" });
    },
  );

  it("returns status 1 for empty stdin", async () => {
    expect(await run(["needle"], "stdin", "")).toEqual({
      status: exited(1),
      stdout: "",
      stderr: "",
    });
  });

  it("returns status 1 for no matches", async () => {
    expect(await run(["-E", "does-not-match-any-line"])).toEqual({
      status: exited(1),
      stdout: "",
      stderr: "",
    });
  });
});
