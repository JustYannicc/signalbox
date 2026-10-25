import { describe, expect, it } from "vite-plus/test";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashCall } from "../../kernel/KernelBashPort.ts";
import { createChildBashImports } from "../ChildBashImports.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { bashCredentials, childBashFixture, text } from "./ChildBashFixture.ts";
import { nimbusCapacityCommand } from "./ChildNimbusCapacityFixture.ts";
const cases = [
  {
    label: "cwd output fits when capacity exceeds memory",
    name: "startup_cwd",
    args: [65_520, 17],
    out: 65_520,
    expected: 10,
  },
  {
    label: "account output fits when capacity exceeds memory",
    name: "account",
    args: [0, 0, 0, 0, 1000, 65_472, 65, 32],
    out: 65_472,
    expected: 0,
  },
  {
    label: "cwd output exceeds memory",
    name: "startup_cwd",
    args: [65_530, 17],
    out: 65_530,
    expected: -21,
  },
  {
    label: "account output exceeds memory",
    name: "account",
    args: [0, 0, 0, 0, 1000, 65_530, 65, 32],
    out: 65_530,
    expected: 21,
  },
  {
    label: "cwd capacity is too small",
    name: "startup_cwd",
    args: [65_520, 10],
    out: 65_520,
    expected: -68,
  },
  {
    label: "account capacity is too small",
    name: "account",
    args: [0, 0, 0, 0, 1000, 65_472, 1, 32],
    out: 65_472,
    expected: 68,
  },
];

function fixture() {
  const result = childBashFixture();
  result.filesystem.mkdir("/etc");
  result.write("/etc/passwd", "owner:x:1000:1000:Owner:/workspace:/bin/bash\n");
  return result;
}

describe("Bash Nimbus output capacity", () => {
  it.each(cases)("Bash imports: $label", async ({ name, args, out, expected }) => {
    const module = nimbusCapacityCommand(name, args, out);
    const process = fixture();
    const owner = createKernelBashHost({
      context: process.context,
      credentials: bashCredentials,
    });
    const requests: KernelBashCall[] = [];
    try {
      const wasi = createChildWasi({ module, syscalls: owner.port, args: [], env: {} });
      const imports = createChildBashImports({
        module,
        port: {
          ...owner.port,
          async callBash(request) {
            requests.push(request);
            return structuredClone(await owner.port.callBash(structuredClone(request)));
          },
        },
      });
      const instance = new WebAssembly.Instance(module, { ...wasi.imports, ...imports.imports });
      wasi.bind(instance);
      imports.bind(instance);
      expect(await wasi.start(instance)).toBe(0);
      const actual = process.stdoutBytes();
      expect(new DataView(actual.buffer, actual.byteOffset).getInt32(0, true)).toBe(expected);
      if (expected === 10) expect(actual.subarray(8, 19)).toEqual(text("/workspace\0"));
      if (expected === 0) {
        const needed = new DataView(actual.buffer, actual.byteOffset).getUint32(4, true);
        expect(actual.subarray(16, 8 + needed)).toEqual(
          text("owner\0x\0Owner\0/workspace\0/bin/bash\0"),
        );
        expect(actual.at(-1)).toBe(0xa5);
      }
      expect(requests[0]!.args).toEqual(args);
      expect(requests[0]!.memorySize).toBe(65_536);
    } finally {
      await owner.close();
      await process.close();
    }
  });
});
