// @effect-diagnostics nodeBuiltinImport:off - reads only locally prepared, hash-pinned WASM artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import {
  KERNEL_BUSYBOX_ARTIFACT,
  createKernelBusyboxProgram,
} from "../../kernel/KernelBusyboxProgram.ts";
import type { KernelBusyboxCall, KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildBusyboxProgram } from "../ChildBusyboxProgram.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

// Third-party artifacts stay local. A present artifact with the wrong pin must fail.
const artifact = new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT === "1")
  throw new Error("SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT=1 requires .t3/1071/programs/busybox.wasm");
let bytes: Uint8Array<ArrayBuffer>;
let module: WebAssembly.Module;
if (available) {
  bytes = new Uint8Array(NodeFS.readFileSync(artifact));
  if (
    bytes.length !== KERNEL_BUSYBOX_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BUSYBOX_ARTIFACT.sha256
  )
    throw new Error("BusyBox test artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

function child(fixture: ReturnType<typeof childBusyboxFixture>, port: KernelBusyboxPort) {
  return createChildBusybox({ module, port, args: fixture.context.args, env: fixture.context.env });
}

describe.skipIf(!available)("actual pinned BusyBox child", () => {
  it("copies binary stdin to the borrowed stdout using only syscall ABI ranges", async () => {
    const input = Uint8Array.from({ length: 180_013 }, (_, index) => index % 256);
    const fixture = childBusyboxFixture({ stdin: input });
    const owner = createKernelBusyboxHost({ context: fixture.context });
    const requests: (KernelSyscallRequest | KernelBusyboxCall)[] = [];
    const port: KernelBusyboxPort = {
      call: async (request) => {
        requests.push(request);
        return structuredClone(await owner.port.call(structuredClone(request)));
      },
      callBusybox: async (request) => {
        requests.push(request);
        return structuredClone(await owner.port.callBusybox(structuredClone(request)));
      },
    };
    try {
      expect(await child(fixture, port).run()).toEqual(exited());
      expect(fixture.stdout()).toEqual(input);
      expect(fixture.stderr()).toBe("");
      expect(requests.some((request) => request.name === "fd_read")).toBe(true);
      for (const request of requests) {
        const copied = request.regions.reduce((size, region) => size + region.bytes.length, 0);
        expect(copied).toBeLessThan(request.memorySize);
        expect(copied).toBeLessThanOrEqual(1024 * 1024 + 16);
      }
      await owner.close();
      expect(fixture.filesystem.descriptors.has(0)).toBe(true);
      expect(fixture.filesystem.descriptors.has(1)).toBe(true);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("resolves relative and absolute inputs from the prepared cwd with hidden preopens", async () => {
    const fixture = childBusyboxFixture({
      args: ["/caller/path/cat", "nested/relative", "/workspace/absolute"],
    });
    fixture.write("nested/relative", "relative雪");
    fixture.write("absolute", "|absolute");
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect(await child(fixture, owner.port).run()).toEqual(exited());
      expect(new TextDecoder().decode(fixture.stdout())).toBe("relative雪|absolute");
      expect(fixture.filesystem.cwd).toBe("/workspace");
      expect(fixture.stderr()).toBe("");
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("preserves a missing-file failure, split stderr and the next operand", async () => {
    const fixture = childBusyboxFixture({ args: ["cat", "missing", "present"] });
    fixture.write("present", "survives");
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect(await child(fixture, owner.port).run()).toEqual(exited(1));
      expect(new TextDecoder().decode(fixture.stdout())).toBe("survives");
      expect(fixture.stderr()).toContain("missing");
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("passes caller environment bytes and empty values unchanged", async () => {
    const fixture = childBusyboxFixture({
      args: ["busybox", "env"],
      env: { EXACT: "snow雪 with spaces", EMPTY: "", PWD: "/caller-value" },
    });
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect(await child(fixture, owner.port).run()).toEqual(exited());
      expect(new TextDecoder().decode(fixture.stdout()).split("\n").sort()).toEqual(
        ["EXACT=snow雪 with spaces", "EMPTY=", "PWD=/caller-value", ""].sort(),
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("uses facet credentials and Nimbus passwd/group account records", async () => {
    const fixture = childBusyboxFixture({ args: ["busybox", "ls", "-l", "owned"] });
    fixture.write("/etc/passwd", "owner:x:1000:1000:Owner:/workspace:/bin/bash\n");
    fixture.write("/etc/group", "team:x:1000:owner\n");
    fixture.write("owned", "owned file", 0o640);
    const owner = createKernelBusyboxHost({ context: fixture.context });
    try {
      expect(await child(fixture, owner.port).run()).toEqual(exited());
      expect(new TextDecoder().decode(fixture.stdout())).toMatch(
        /-rw-r-----\s+1\s+owner\s+team\s+10\s/,
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("runs through the shared child admission wrapper without a parent WASM module", async () => {
    const fixture = childBusyboxFixture({ args: ["cat", "from-facet"] });
    fixture.write("from-facet", "shared resources");
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-childbusybox-test-1",
    });
    let captured: KernelBusyboxPort | undefined;
    const program = createChildBusyboxProgram({
      executable: "/bin/cat",
      code: {
        mainModule: "main.js",
        modules: { "main.js": "child entry", "busybox.wasm": { wasm: bytes.buffer } },
      },
      capacity,
      dispatch: {
        async run(input, port) {
          captured = port;
          expect(capacity.active).toBe(1);
          expect(input.command.argv).toEqual(["cat", "from-facet"]);
          expect(input.command.cwd).toBe("/workspace");
          const binary = input.modules["busybox.wasm"];
          if (binary === undefined || typeof binary === "string" || !("wasm" in binary))
            throw new Error("Missing child binary");
          if (!(binary.wasm instanceof ArrayBuffer)) throw new Error("Expected raw child bytes");
          return createChildBusybox({
            module: new WebAssembly.Module(binary.wasm),
            port,
            args: input.command.argv,
            env: input.command.env,
          }).run();
        },
      },
    });
    try {
      expect(await program.run(fixture.context)).toEqual(exited());
      expect(new TextDecoder().decode(fixture.stdout())).toBe("shared resources");
      expect(capacity.active).toBe(0);
      expect(fixture.filesystem.descriptors.has(1)).toBe(true);
      await expect(
        captured!.callBusybox({ name: "identity", args: [0], memorySize: 0, regions: [] }),
      ).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      await fixture.close();
    }
  });

  it("retains the existing same-isolate BusyBox runtime after sparse import extraction", async () => {
    const fixture = childBusyboxFixture({ args: ["cat", "existing"] });
    fixture.write("existing", "original runtime");
    try {
      expect(await createKernelBusyboxProgram({ module }).run(fixture.context)).toEqual(exited());
      expect(new TextDecoder().decode(fixture.stdout())).toBe("original runtime");
      expect(fixture.stderr()).toBe("");
    } finally {
      await fixture.close();
    }
  });
});
