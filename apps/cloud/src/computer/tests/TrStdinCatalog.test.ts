// @effect-diagnostics nodeBuiltinImport:off - checks hash-pinned BusyBox against GNU byte vectors.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  KERNEL_BUSYBOX_ARTIFACT,
  createKernelBusyboxProgram,
} from "../../kernel/KernelBusyboxProgram.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { qualifyTrCommand } from "../TrCommand.ts";
import {
  commandGatewayFixture,
  commandProgramCodes,
  readAll,
} from "./CommandGatewayAdmissionFixture.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import { trMachineVectors, trVectors } from "./TrVectors.fixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const artifact =
  NodeProcess.env.SIGNALBOX_BUSYBOX_ARTIFACT ??
  new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_TR_PIPELINE_ARTIFACTS === "1")
  throw new Error("Pinned BusyBox is required for tr vectors");
let module: WebAssembly.Module;
let code: ReturnType<typeof commandProgramCodes>["busyboxCat"];
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_BUSYBOX_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BUSYBOX_ARTIFACT.sha256
  )
    throw new Error("BusyBox tr artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
  code = {
    mainModule: "busybox.js",
    modules: {
      "busybox.js": "export default class {}",
      "busybox.wasm": {
        wasm: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      },
    },
  };
}

describe.skipIf(!available)("BusyBox tr through the public catalog", () => {
  it.each(trMachineVectors)("keeps the GNU mismatch for $args on the machine", async (vector) => {
    const command = {
      executable: "/usr/bin/tr",
      argv: ["tr", ...vector.args],
      cwd: "/workspace",
      env: { LC_ALL: "C" },
    };
    const raw = childBusyboxFixture({
      args: command.argv,
      env: command.env,
      stdin: new TextEncoder().encode(vector.input),
    });
    try {
      const result = await createKernelBusyboxProgram({ module }).run(raw.context);
      const actual = { stdout: new TextDecoder().decode(raw.stdout()), exitCode: result.exitCode };
      expect(actual).toEqual(vector.busybox);
      expect(actual).not.toEqual(vector.gnu);
    } finally {
      await raw.close();
    }
    const fixture = commandGatewayFixture({
      run: async () => {
        throw new Error("GNU-incompatible tr reached the isolate");
      },
    });
    try {
      expect(qualifyTrCommand(command)).toMatchObject({ kind: "machine" });
      const child = await fixture.gateway.exec(command, fixture.controller.signal, undefined);
      await child.exited;
      await child.dispose();
      expect(fixture.machineSpawn).toHaveBeenCalledExactlyOnceWith(
        command,
        expect.any(AbortSignal),
      );
    } finally {
      await fixture.close();
    }
  });
  it.each(trVectors)("matches GNU coreutils for $args", async ({ args, expectedHex }) => {
    const base = commandProgramCodes();
    const fixture = commandGatewayFixture({
      programs: { ...base, busyboxApplets: code },
      run: async (input, invocation) => {
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
    const command = {
      executable: "/usr/bin/tr",
      argv: ["tr", ...args],
      cwd: "/workspace",
      env: { LC_ALL: "C" },
    };
    try {
      expect(qualifyTrCommand(command)).toEqual({ kind: "qualified-isolate" });
      const child = await fixture.gateway.exec(command, fixture.controller.signal, undefined);
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          readAll(child.stdout),
          readAll(child.stderr),
          (async () => {
            const writer = child.stdin.getWriter();
            try {
              await writer.write(Uint8Array.from({ length: 512 }, (_, index) => index % 256));
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          })(),
        ]);
        expect(status).toEqual(exited());
        expect(Buffer.from(stdout).toString("hex")).toBe(expectedHex);
        expect(new TextDecoder().decode(stderr)).toBe("");
        expect(fixture.machineSpawn).not.toHaveBeenCalled();
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.close();
    }
  });
  it("forwards unsupported GNU syntax without starting an applet", async () => {
    const fixture = commandGatewayFixture({
      run: async () => {
        throw new Error("Unqualified tr reached the isolate");
      },
    });
    try {
      const child = await fixture.gateway.exec(
        {
          executable: "/usr/bin/tr",
          argv: ["tr", "-t", "ab", "x"],
          cwd: "/workspace",
          env: { LC_ALL: "C" },
        },
        fixture.controller.signal,
        undefined,
      );
      await child.exited;
      await child.dispose();
      expect(fixture.machineSpawn).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });
});
