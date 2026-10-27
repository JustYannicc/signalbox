// @effect-diagnostics nodeBuiltinImport:off - reads only the local hash-pinned GNU sed artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";
import { commandGatewayFixture, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const ranges = [
  [95, 1, 140],
  [97, 1, 90],
  [99, 1, 200],
  [106, 1, 110],
  [111, 1, 80],
  [113, 1, 80],
  [115, 1, 80],
  [125, 1, 40],
  [127, 95, 130],
  [129, 280, 330],
  [141, 1, 60],
  [146, 1, 30],
] as const;

const command = (script: string, args: readonly string[] = []) => ({
  executable: "/usr/bin/sed",
  argv: ["sed", "-n", script, ...args],
  cwd: "/work",
  env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
});

it.each(ranges)("qualifies stdin range %i", (_id, start, end) => {
  expect(qualifyGnuCommand(command(`${start},${end}p`))).toEqual({
    kind: "qualified-isolate",
  });
});

it.each([
  { ...command("1,40p"), env: { POSIXLY_CORRECT: "1" } },
  { ...command("1,40p"), env: { LC_ALL: "fr_CH.UTF-8" } },
  command("1,40p", ["-"]),
  command("1,40p", [""]),
  { ...command("s/a/b/"), argv: ["sed", "-i", "s/a/b/"] },
  command("1,40p", ["--sandbox"]),
])("keeps unsupported stdin semantics on the machine for %j", (input) => {
  expect(qualifyGnuCommand(input).kind).toBe("machine");
});

const artifact =
  NodeProcess.env.SIGNALBOX_GNU_SED_ARTIFACT ??
  new URL("../../../../../.t3/1071/programs/sed.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_GNU_ARTIFACTS === "1")
  throw new Error("The sed stdin catalog test requires the pinned GNU sed artifact");
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_GNU_SED_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_GNU_SED_ARTIFACT.sha256
  )
    throw new Error("The sed stdin catalog artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} 雪\n`);

describe.skipIf(!available)("pinned GNU sed through the public command gateway", () => {
  it.each(ranges)("runs stdin range %i without a machine", async (_id, start, end) => {
    const dispatched: string[] = [];
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        dispatched.push(input.command.executable);
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
      const child = await fixture.gateway.exec(
        command(`${start},${end}p`),
        fixture.controller.signal,
        undefined,
      );
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          readAll(child.stdout),
          readAll(child.stderr),
          (async () => {
            const writer = child.stdin.getWriter();
            try {
              await writer.write(new TextEncoder().encode(lines.join("")));
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          })(),
        ]);
        expect(status).toEqual(exited(0));
        expect(new TextDecoder().decode(stdout)).toBe(lines.slice(start - 1, end).join(""));
        expect(stderr).toEqual(new Uint8Array());
      } finally {
        await child.dispose();
      }
      await fixture.gateway.drain();
      expect(dispatched).toEqual(["/usr/bin/sed"]);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
      expect(fixture.capacity.active).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
