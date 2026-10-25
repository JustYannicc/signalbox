// @effect-diagnostics nodeBuiltinImport:off - reads only the locally prepared, hash-pinned WASM test artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT, createKernelBashProgram } from "../../kernel/KernelBashProgram.ts";
import { createChildBash } from "../ChildBash.ts";
import { assertComputerForwardingSupported } from "../ComputerForwardedProgram.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && process.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error(`Required GNU Bash test artifact is missing: ${artifact.pathname}`);
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("GNU Bash test artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

describe.skipIf(!available)("GNU Bash saved redirection descriptors", () => {
  it.each([false, true])(
    "marks saved descriptors close-on-exec before replacement, child=%s",
    async (child) => {
      let replacements = 0;
      const fixture = childBashFixture({
        args: ["bash", "--noprofile", "--norc", "-c", "f() { exec /bin/external; }; f > output"],
        exec: async (request) => {
          const saved = [...request.filesystem.descriptors.entries()].filter(
            ([fd, descriptor]) => fd > 2 && !descriptor.preopen,
          );
          expect(saved.length).toBeGreaterThan(0);
          expect(saved.every(([, descriptor]) => descriptor.closeOnExec)).toBe(true);
          assertComputerForwardingSupported({
            kind: "exec",
            command: {
              executable: request.path,
              argv: request.args,
              env: request.env,
              cwd: "/workspace",
            },
            baseCwd: "/workspace",
            actions: [],
            attributes: undefined,
            filesystem: request.filesystem,
            processes: fixture.processes,
            identity: request.identity,
            signal: request.signal,
            target: { kind: "unsupported", code: "NOT_FOUND", message: "machine program" },
          });
          replacements++;
          return exited(23);
        },
      });
      fixture.write("/bin/external", "", 0o755);
      try {
        const program = child
          ? createChildBash({
              module,
              credentials: bashCredentials,
              pid: fixture.owner.pid,
              port: fixture.owner.port,
              args: fixture.context.args,
              env: fixture.context.env,
            })
          : createKernelBashProgram({ module, credentials: bashCredentials });
        expect(await program.run(fixture.context)).toEqual(exited(23));
        expect(replacements).toBe(1);
        expect(fixture.stderr()).toBe("");
      } finally {
        await fixture.close();
      }
    },
  );
});
