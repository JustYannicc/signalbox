import { describe, expect, it } from "vite-plus/test";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { createKernelBusyboxProgram } from "../../kernel/KernelBusyboxProgram.ts";
import type { KernelBusyboxCall } from "../../kernel/KernelBusyboxPort.ts";
import { createChildBashImports } from "../ChildBashImports.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { busyboxCredentials, childBusyboxFixture, exited, text } from "./ChildBusyboxFixture.ts";
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
  const result = childBusyboxFixture();
  result.write("/etc/passwd", "owner:x:1000:1000:Owner:/workspace:/bin/bash\n");
  return result;
}

async function native(module: WebAssembly.Module) {
  const owner = fixture();
  try {
    expect(await createKernelBusyboxProgram({ module }).run(owner.context)).toEqual(exited());
    return owner.stdout();
  } finally {
    await owner.close();
  }
}

function assertResult(actual: Uint8Array, expected: Uint8Array, status: number) {
  expect(new DataView(actual.buffer, actual.byteOffset).getInt32(0, true)).toBe(status);
  expect(actual).toEqual(expected);
  if (status === 10) expect(actual.subarray(8, 19)).toEqual(text("/workspace\0"));
  if (status === 0) {
    const needed = new DataView(actual.buffer, actual.byteOffset).getUint32(4, true);
    expect(actual.subarray(16, 8 + needed)).toEqual(
      text("owner\0x\0Owner\0/workspace\0/bin/bash\0"),
    );
    expect(actual.at(-1)).toBe(0xa5);
  }
}

describe("Nimbus output capacity native/child parity", () => {
  it.each(cases)("BusyBox: $label", async ({ name, args, out, expected }) => {
    const module = nimbusCapacityCommand(name, args, out);
    const baseline = await native(module);
    const process = fixture();
    const owner = createKernelBusyboxHost({ context: process.context });
    const requests: KernelBusyboxCall[] = [];
    try {
      expect(
        await createChildBusybox({
          module,
          args: [],
          env: {},
          port: {
            ...owner.port,
            async callBusybox(request) {
              requests.push(request);
              return structuredClone(await owner.port.callBusybox(structuredClone(request)));
            },
          },
        }).run(),
      ).toEqual(exited());
      assertResult(process.stdout(), baseline, expected);
      expect(requests[0]!.args).toEqual(args);
      expect(requests[0]!.memorySize).toBe(65_536);
      expect(
        requests[0]!.regions.every((region) => region.pointer + region.bytes.length <= 65_536),
      ).toBe(true);
    } finally {
      await owner.close();
      await process.close();
    }
  });

  it.each(cases)("Bash imports: $label", async ({ name, args, out, expected }) => {
    const module = nimbusCapacityCommand(name, args, out);
    const baseline = await native(module);
    const process = fixture();
    const owner = createKernelBashHost({
      context: process.context,
      credentials: { ...busyboxCredentials, umask: 0o022, hostname: "capacity-test" },
    });
    const requests: KernelBusyboxCall[] = [];
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
      assertResult(process.stdout(), baseline, expected);
      expect(requests[0]!.args).toEqual(args);
      expect(requests[0]!.memorySize).toBe(65_536);
    } finally {
      await owner.close();
      await process.close();
    }
  });
});
