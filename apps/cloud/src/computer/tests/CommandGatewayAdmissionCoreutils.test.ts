import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelCoreutilsPort } from "../../kernel/KernelCoreutilsPort.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import type { KernelSyscallPort, KernelSyscallResponse } from "../../kernel/KernelSyscallPort.ts";
import { createChildCoreutils } from "../ChildCoreutils.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { commandGatewayFixture, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { wasmEnvironmentGetCommand } from "./CoreutilsWasmImportFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const cases = [
  ["missing PWD", { PATH: "/bin" }],
  ["stale PWD", { PATH: "/bin", PWD: "/x" }],
] as const;

describe.each(cases)("uniform gateway with %s", (_label, env) => {
  it("claims the original Coreutils context, then gives the parent and child the admitted PWD", async () => {
    let parentEnvironment = "";
    let childEnvironment = "";
    let childExitCode = -1;
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        try {
          expect(input.command).toEqual({
            executable: "/bin/pwd",
            argv: ["pwd-argv0"],
            cwd: "/workspace",
            env: { ...env, PWD: "/workspace" },
          });
          const host = await invocation.host<KernelCoreutilsPort>();
          parentEnvironment = await readEnvironment(host);
          const guestPort: KernelCoreutilsPort = {
            async call(request) {
              const response = await host.call(request);
              if (request.name === "environ_get" && response.kind === "return") {
                childEnvironment = regionText(response, 64);
              }
              return response;
            },
            callCoreutils: (request) => host.callCoreutils(request),
          };
          const result = await createChildCoreutils({
            module: wasmEnvironmentGetCommand(),
            port: guestPort,
            args: input.command.argv,
            env: input.command.env,
          }).run();
          childExitCode = result.exitCode;
          return result;
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const reserve = vi.spyOn(fixture.capacity, "reserve");
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let child: KernelCommandChild | undefined;
    try {
      child = await fixture.gateway.exec(
        {
          executable: "/bin/pwd",
          argv: ["pwd-argv0"],
          cwd: "/workspace",
          env,
        },
        fixture.controller.signal,
        undefined,
      );
      const [stdout, stderr, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      expect(stdout).toHaveLength(0);
      expect(stderr).toHaveLength(0);
      expect(status.exitCode).toBe(0);
      expect(childExitCode).toBe(0);
      expect(parentEnvironment).toBe("PATH=/bin\0PWD=/workspace");
      expect(childEnvironment).toBe("PATH=/bin\0PWD=/workspace");
      expect(fixture.capacity.active).toBe(0);
      expect(reserve).toHaveBeenCalledOnce();
      expect(reacquire).not.toHaveBeenCalled();
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      await child?.dispose();
      await fixture.close();
    }
  });

  it("claims the original ripgrep context, then gives the parent and child the admitted PWD", async () => {
    let parentEnvironment = "";
    let childEnvironment = "";
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        try {
          expect(input.command).toEqual({
            executable: "/bin/rg",
            argv: ["rg-argv0", "needle", "."],
            cwd: "/workspace",
            env: { ...env, PWD: "/workspace" },
          });
          const host = await invocation.host<KernelSyscallPort>();
          parentEnvironment = await readEnvironment(host);
          const syscalls: KernelSyscallPort = {
            async call(request) {
              const response = await host.call(request);
              if (request.name === "environ_get" && response.kind === "return") {
                childEnvironment = regionText(response, 64);
              }
              return response;
            },
          };
          const module = wasmEnvironmentGetCommand();
          const wasi = createChildWasi({
            module,
            args: input.command.argv,
            env: input.command.env,
            syscalls,
          });
          const instance = new WebAssembly.Instance(module, wasi.imports);
          wasi.bind(instance);
          return { exitCode: await wasi.start(instance), signal: 0, coreDumped: false };
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const reserve = vi.spyOn(fixture.capacity, "reserve");
    const reacquire = vi.spyOn(fixture.capacity, "run");
    let child: KernelCommandChild | undefined;
    try {
      child = await fixture.gateway.exec(
        {
          executable: "/bin/rg",
          argv: ["rg-argv0", "needle", "."],
          cwd: "/workspace",
          env,
        },
        fixture.controller.signal,
        undefined,
      );
      const [stdout, stderr, status] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      expect(stdout).toHaveLength(0);
      expect(stderr).toHaveLength(0);
      expect(status.exitCode).toBe(0);
      expect(parentEnvironment).toBe("PATH=/bin\0PWD=/workspace");
      expect(childEnvironment).toBe("PATH=/bin\0PWD=/workspace");
      expect(fixture.capacity.active).toBe(0);
      expect(reserve).toHaveBeenCalledOnce();
      expect(reacquire).not.toHaveBeenCalled();
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      await child?.dispose();
      await fixture.close();
    }
  });
});

async function readEnvironment(port: KernelSyscallPort): Promise<string> {
  const sizes = await port.call({
    name: "environ_sizes_get",
    args: [0, 4],
    memorySize: 4096,
    regions: [
      { pointer: 0, bytes: new Uint8Array(4) },
      { pointer: 4, bytes: new Uint8Array(4) },
    ],
  });
  if (sizes.kind !== "return" || sizes.value !== 0) throw new Error("Could not size environment");
  const count = readU32(sizes, 0);
  const byteLength = readU32(sizes, 4);
  const response = await port.call({
    name: "environ_get",
    args: [64, 256],
    memorySize: 4096,
    regions: [
      { pointer: 64, bytes: new Uint8Array(count * 4) },
      { pointer: 256, bytes: new Uint8Array(byteLength) },
    ],
  });
  if (response.kind !== "return" || response.value !== 0)
    throw new Error("Could not read environment");
  return regionText(response, 256);
}

function readU32(response: KernelSyscallResponse, pointer: number): number {
  const region =
    response.kind === "return"
      ? response.regions.find((candidate) => candidate.pointer === pointer)
      : undefined;
  if (region === undefined) throw new Error(`Missing environment size at ${pointer}`);
  return new DataView(
    region.bytes.buffer,
    region.bytes.byteOffset,
    region.bytes.byteLength,
  ).getUint32(0, true);
}

function regionText(response: KernelSyscallResponse, pointer: number): string {
  const region =
    response.kind === "return"
      ? response.regions.find((candidate) => candidate.pointer === pointer)
      : undefined;
  if (region === undefined) throw new Error(`Missing environment buffer at ${pointer}`);
  return new TextDecoder().decode(region.bytes);
}
