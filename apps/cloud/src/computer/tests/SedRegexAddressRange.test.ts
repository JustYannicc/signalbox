// @effect-diagnostics nodeBuiltinImport:off - reads only the local hash-pinned GNU sed artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";
import { commandGatewayFixture, exited, readAll } from "./CommandGatewayAdmissionFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact =
  NodeProcess.env.SIGNALBOX_GNU_SED_ARTIFACT ??
  new URL("../../../../../.t3/1071/programs/sed.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_GNU_ARTIFACTS === "1") {
  throw new Error("The regex address range test requires the pinned GNU sed WASM artifact");
}

let module: WebAssembly.Module | undefined;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.byteLength !== KERNEL_GNU_SED_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_GNU_SED_ARTIFACT.sha256
  ) {
    throw new Error("GNU sed test artifact does not match its pin");
  }
  module = new WebAssembly.Module(bytes);
}

const command = (argv: readonly string[]) => ({
  executable: "/bin/sed",
  argv,
  cwd: "/work",
  env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
});

it("keeps non-literal regex address ranges outside the isolate subset", () => {
  expect(
    qualifyGnuCommand(command(["sed", "-n", "/^## .*/,/^## Decisions/p", "document.md"])).kind,
  ).toBe("machine");
});

describe.skipIf(module === undefined)(
  "GNU sed regex address range through the command gateway",
  () => {
    it("pipes the recorded address range into the numeric range in the isolate", async () => {
      const rangeCommand = command(["sed", "-n", "/^## Notes/,/^## Decisions/p", "document.md"]);
      const numericCommand = command(["sed", "-n", "20,45p"]);
      expect(qualifyGnuCommand(rangeCommand)).toEqual({ kind: "qualified-isolate" });
      expect(qualifyGnuCommand(numericCommand)).toEqual({ kind: "qualified-isolate" });

      const notes = Array.from(
        { length: 43 },
        (_, index) => `note-${String(index + 1).padStart(2, "0")}`,
      );
      const contents = ["## Overview", "outside", "## Notes", ...notes, "## Decisions", "after"]
        .join("\n")
        .concat("\n");
      const expected = [...notes.slice(18), "## Decisions"].join("\n").concat("\n");
      const dispatched: string[] = [];
      const fixture = commandGatewayFixture({
        run: async (input, invocation) => {
          dispatched.push(input.command.executable);
          try {
            return await createChildBusybox({
              module: module!,
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
      fixture.write("/work/document.md", contents);

      let first: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
      let second: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
      try {
        first = await fixture.gateway.exec(rangeCommand, fixture.controller.signal, undefined);
        second = await fixture.gateway.exec(numericCommand, fixture.controller.signal, undefined);
        const piped = first.stdout.pipeTo(second.stdin);
        const [, firstStatus, secondStatus, stdout, firstStderr, secondStderr] = await Promise.all([
          piped,
          first.exited,
          second.exited,
          readAll(second.stdout),
          readAll(first.stderr),
          readAll(second.stderr),
        ]);

        expect(firstStatus).toEqual(exited(0));
        expect(secondStatus).toEqual(exited(0));
        expect(new TextDecoder().decode(stdout)).toBe(expected);
        expect(firstStderr).toEqual(new Uint8Array());
        expect(secondStderr).toEqual(new Uint8Array());
        await fixture.gateway.drain();
        expect(dispatched).toEqual(["/bin/sed", "/bin/sed"]);
        expect(fixture.machineSpawn).not.toHaveBeenCalled();
        expect(fixture.capacity.active).toBe(0);
      } finally {
        await Promise.all([first?.dispose(), second?.dispose()]);
        await fixture.close();
      }
    });
  },
);
