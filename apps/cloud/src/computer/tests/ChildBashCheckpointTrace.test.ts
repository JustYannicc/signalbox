// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBashOperation } from "../../kernel/KernelBashCheckpoint.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error("Required GNU Bash test artifact is missing");
const module = available
  ? (() => {
      const bytes = NodeFS.readFileSync(artifact);
      if (
        bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
      )
        throw new Error("GNU Bash test artifact does not match its pin");
      return new WebAssembly.Module(bytes);
    })()
  : undefined;

describe.skipIf(!available)("Bash Asyncify syscall trace", () => {
  it("writes a marker and records the Asyncify filesystem syscall landings", async () => {
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "-c", "printf marker > /workspace/marker"],
    });
    const trace: string[] = [];
    const port: KernelBashPort = {
      ...fixture.owner.port,
      async startOperation(operation: KernelBashOperation) {
        const name =
          operation.kind === "wasi" || operation.kind === "bash"
            ? operation.request.name
            : operation.kind;
        trace.push(`operation:${operation.kind}:${name}`);
        switch (operation.kind) {
          case "wasi":
            return {
              kind: "ready",
              result: { kind: "wasi", value: await fixture.owner.port.call(operation.request) },
            };
          case "bash":
            return {
              kind: "ready",
              result: { kind: "bash", value: await fixture.owner.port.callBash(operation.request) },
            };
          case "wait":
            return {
              kind: "ready",
              result: {
                kind: "wait",
                value: await fixture.owner.port.wait(operation.pid, operation.options),
              },
            };
          case "exec":
            return {
              kind: "ready",
              result: { kind: "exec", value: await fixture.owner.port.exec(operation.request) },
            };
        }
      },
    };
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port,
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      const result = await reactor.run();
      await reactor.drain();
      expect(result).toEqual(exited());
      expect(fixture.stdout()).toBe("");
      expect(fixture.read("/workspace/marker")).toBe("marker");
      expect(trace).toContain("operation:wasi:path_open");
      expect(trace).toContain("operation:wasi:fd_write");
      expect(trace).not.toContain("operation:bash:umask");
    } finally {
      await fixture.close();
    }
  });
});
