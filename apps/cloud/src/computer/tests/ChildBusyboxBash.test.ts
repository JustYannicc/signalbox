// @effect-diagnostics nodeBuiltinImport:off - reads only locally prepared, hash-pinned WASM artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

const busyboxPath = new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url);
const bashPath = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(busyboxPath) && NodeFS.existsSync(bashPath);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT === "1")
  throw new Error(
    "SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT=1 requires both .t3/1071/programs/busybox.wasm and .t3/1071/programs/bash.wasm",
  );
const pinned = (path: URL, pin: { readonly bytes: number; readonly sha256: string }) => {
  const bytes = NodeFS.readFileSync(path);
  if (
    bytes.length !== pin.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  )
    throw new Error("Child hook WASM artifact does not match its pin");
  return new WebAssembly.Module(bytes);
};

describe.skipIf(!available)("actual Bash to BusyBox child source integration", () => {
  it("appends hook JSONL through cat with the fork's prepared stdin and redirected stdout", async () => {
    const busybox = pinned(busyboxPath, KERNEL_BUSYBOX_ARTIFACT);
    const bash = pinned(bashPath, KERNEL_BASH_ARTIFACT);
    const event = '{"event":"child","value":"snow雪"}\n';
    const identities: number[] = [];
    const fixture = childBashFixture({
      args: [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        'printf "%s" "$EVENT" | cat >> events.jsonl; printf "%s" "$EVENT" | cat >> events.jsonl',
      ],
      env: { HOME: "/workspace", PATH: "/bin", EVENT: event },
      async exec(request) {
        expect(request.path).toBe("/bin/cat");
        expect(request.args).toEqual(["cat"]);
        expect(request.env.EVENT).toBe(event);
        expect(request.filesystem.cwd).toBe("/workspace");
        expect(request.filesystem).not.toBe(fixture.filesystem);
        identities.push(request.identity.pid);
        const owner = createKernelBusyboxHost({ context: { ...fixture.context, ...request } });
        try {
          return await createChildBusybox({
            module: busybox,
            port: owner.port,
            args: request.args,
            env: request.env,
          }).run();
        } finally {
          await owner.close();
        }
      },
    });
    fixture.write("/bin/cat", "", 0o755);
    fixture.write("events.jsonl", '{"event":"existing"}\n');
    try {
      expect(
        await createChildBash({
          module: bash,
          credentials: bashCredentials,
          pid: fixture.owner.pid,
          port: fixture.owner.port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run(),
      ).toEqual(exited());
      expect(identities).toHaveLength(2);
      expect(identities.every((pid) => pid !== fixture.context.identity.pid)).toBe(true);
      expect(fixture.read("events.jsonl")).toBe('{"event":"existing"}\n' + event + event);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe("");
      expect(fixture.processes.size).toBe(1);
      expect(fixture.wakes.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
