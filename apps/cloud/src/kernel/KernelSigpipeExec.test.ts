import { describe, expect, it } from "vite-plus/test";
import { callKernel } from "./KernelAbi.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import type { KernelSyscallRequest } from "./KernelSyscallPort.ts";
import type { KernelProgramBinding, KernelAsyncProgramContext } from "./KernelProgramHost.ts";
import {
  asyncBinding,
  createAdmissionKernel,
  exitStatus,
  manifest,
} from "./tests/kernelProgramAdmissionFixture.ts";
import { wasmImportReactor, wasmSignalMaskCommand, wasmSigpipeCommand } from "./tests/wasmGuest.ts";

const blockedSigpipe = { low: 4096, high: 0 };
const write: KernelSyscallRequest = {
  name: "fd_write",
  args: [1, 0, 1, 12],
  memorySize: 64,
  regions: [
    { pointer: 0, bytes: new Uint8Array([16, 0, 0, 0, 1, 0, 0, 0]) },
    { pointer: 12, bytes: new Uint8Array(4) },
    { pointer: 16, bytes: new Uint8Array([121]) },
  ],
};

function execRequest(context: KernelAsyncProgramContext, path: string) {
  const { filesystem, identity, signal, args, env } = context;
  return { filesystem, identity, signal, args, env, path };
}

function driver(sigpipe: "terminate" | "epipe", replacement = "/bin/replacement") {
  const binding = asyncBinding("driver", async (context) => {
    expect(context.processes.signalMask(context.identity.handle, 0, blockedSigpipe).status).toBe(
      "ok",
    );
    const port = createKernelSyscallHost({ ...context, process: context, sigpipe });
    try {
      for (let count = 0; count < 2; count++) {
        expect(await port.call(write)).toMatchObject({ kind: "return", value: 64 });
      }
    } finally {
      port.close();
    }
    return context.exec(execRequest(context, replacement));
  });
  return { ...binding, implementation: { ...binding.implementation, sigpipe } };
}

async function run(
  programs: ReadonlyMap<string, KernelProgramBinding>,
  admission?: "local" | "forward",
) {
  const context = createAdmissionKernel(
    programs,
    admission === undefined
      ? {}
      : {
          admit: async (request) =>
            admission === "forward" &&
            request.target.kind === "resolved" &&
            request.target.binding.implementation.kind === "async"
              ? { kind: "forward", implementation: request.target.binding.implementation }
              : {
                  kind: "local",
                  ...(request.target.kind === "resolved" &&
                  request.target.binding.implementation.kind === "async"
                    ? { onDispatch: () => {} }
                    : {}),
                },
        },
  );
  const piped = context.host.preparePiped({ filesystem: context.filesystem });
  try {
    await piped.stdout.cancel();
    const program = context.host.resolve("/bin/driver");
    if (program.status !== "ok") throw new Error("Missing driver");
    const child = callKernel(context.host.backend(piped.prepared), "process.spawn", {
      program: program.value,
      args: [],
      env: {},
    });
    if (child.status !== "ok") throw new Error("Could not admit driver");
    const status = await context.host.exitStatus(child.value);
    expect(context.host.processes.reap(child.value).status).toBe("ok");
    expect(context.host.wakes.size).toBe(0);
    return status;
  } finally {
    await piped.prepared.release();
    await context.close();
  }
}

describe("SIGPIPE disposition across exec", () => {
  it.each([
    ["terminate", "epipe"],
    ["epipe", "terminate"],
    ["terminate", "terminate"],
    ["epipe", "epipe"],
  ] as const)("uses replacement disposition from %s to %s", async (source, sigpipe) => {
    expect(
      await run(
        new Map<string, KernelProgramBinding>([
          ["/bin/driver", driver(source)],
          [
            "/bin/replacement",
            {
              manifest: manifest("replacement"),
              implementation: {
                kind: "wasm",
                sigpipe,
                module: wasmSigpipeCommand(false, true),
              },
            },
          ],
        ]),
      ),
    ).toEqual({
      status: "ok",
      value: sigpipe === "epipe" ? exitStatus(64) : { exitCode: 0, signal: 13, coreDumped: false },
    });
  });

  it.each([undefined, "local", "forward"] as const)(
    "discards pending SIGPIPE through an ignoring image, admission=%s",
    async (admission) => {
      const ignoring = asyncBinding("ignoring", (context) =>
        context.exec(execRequest(context, "/bin/default")),
      );
      expect(
        await run(
          new Map<string, KernelProgramBinding>([
            ["/bin/driver", driver("terminate")],
            [
              "/bin/replacement",
              { ...ignoring, implementation: { ...ignoring.implementation, sigpipe: "epipe" } },
            ],
            [
              "/bin/default",
              {
                manifest: manifest("default"),
                implementation: {
                  kind: "wasm",
                  module: wasmSignalMaskCommand(1, blockedSigpipe.low, 0),
                },
              },
            ],
          ]),
          admission,
        ),
      ).toEqual({ status: "ok", value: exitStatus(0) });
    },
  );

  it("preserves pending default SIGPIPE when replacement validation fails before commit", async () => {
    const source = asyncBinding("driver", async (context) => {
      expect(context.processes.signalMask(context.identity.handle, 0, blockedSigpipe).status).toBe(
        "ok",
      );
      const port = createKernelSyscallHost({ ...context, process: context });
      try {
        expect(await port.call(write)).toMatchObject({ kind: "return", value: 64 });
      } finally {
        port.close();
      }
      await expect(context.exec(execRequest(context, "/bin/replacement"))).rejects.toBeInstanceOf(
        KernelProgramExecAdmissionError,
      );
      context.processes.signalMask(context.identity.handle, 1, blockedSigpipe);
      return exitStatus(99);
    });
    expect(
      await run(
        new Map<string, KernelProgramBinding>([
          ["/bin/driver", source],
          [
            "/bin/replacement",
            {
              manifest: manifest("invalid"),
              implementation: {
                kind: "wasm",
                sigpipe: "epipe",
                module: wasmImportReactor("missing", "unavailable", []),
              },
            },
          ],
        ]),
      ),
    ).toEqual({ status: "ok", value: { exitCode: 0, signal: 13, coreDumped: false } });
  });
});
