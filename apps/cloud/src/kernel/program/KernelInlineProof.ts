import { ABI_VERSION, callKernel, KernelProgramRegistry } from "../KernelAbi.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { KernelProgramHost } from "../KernelProgramHost.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";

/** Verifies inline tools use the same piped descriptor and process lifecycle as WASM. */
export async function runKernelInlineProof(
  filesystem: KernelFileSystem,
  wakes: KernelWakeRegistry,
) {
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "inline-pipe-proof",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"],
    entrypoint: "inline-pipe-proof",
  } as const;
  if (registry.register(manifest).status !== "ok") throw new Error("Registration failed");
  let calls = 0;
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      [
        "/bin/inline-proof",
        {
          manifest,
          implementation: {
            kind: "javascript",
            runInline: ({ filesystem: child }) => {
              calls++;
              const bytes = new Uint8Array(32);
              const count = child.read(0, bytes, null);
              const written = child.write(1, bytes.subarray(0, count), null);
              child.write(2, new TextEncoder().encode("diagnostic"), null);
              if (written !== count || child.read(0, bytes, null) !== 0)
                throw new Error("Inline pipe I/O failed");
              return 7;
            },
          },
        },
      ],
    ]),
  });
  const resolved = host.resolve("/bin/inline-proof");
  if (resolved.status !== "ok") throw new Error("Resolution failed");
  const piped = host.preparePiped({ filesystem });
  try {
    const writer = piped.stdin.getWriter();
    await writer.write(new TextEncoder().encode("kernel bytes"));
    await writer.close();
    writer.releaseLock();
    const spawned = callKernel(host.backend(piped.prepared), "process.spawn", {
      program: resolved.value,
      args: [],
      env: {},
    });
    if (spawned.status !== "ok") throw new Error("Inline admission failed");
    const status = await host.exitStatus(spawned.value);
    const stdout = await readText(piped.stdout);
    const stderr = await readText(piped.stderr);
    if (
      status.status !== "ok" ||
      status.value.exitCode !== 7 ||
      status.value.signal !== 0 ||
      stdout !== "kernel bytes" ||
      stderr !== "diagnostic"
    ) {
      throw new Error(JSON.stringify({ status, stdout, stderr }));
    }
    if (host.reap(spawned.value).status !== "ok") throw new Error("Inline reap failed");

    const controller = new AbortController();
    const cancelled = host.prepare({ filesystem, signal: controller.signal });
    try {
      const child = callKernel(host.backend(cancelled), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      if (child.status !== "ok") throw new Error("Cancellation admission failed");
      controller.abort();
      const cancellation = await host.exitStatus(child.value);
      if (
        cancellation.status !== "error" ||
        cancellation.error.code !== "CANCELLED" ||
        calls !== 1
      ) {
        throw new Error(JSON.stringify({ cancellation, calls }));
      }
      host.reap(child.value);
      if (host.processes.size !== 0 || wakes.size !== 0)
        throw new Error("Inline process or wake leaked");
      return {
        stdout,
        stderr,
        exitCode: status.value.exitCode,
        cancellation: cancellation.error.code,
      };
    } finally {
      await cancelled.release();
    }
  } finally {
    await piped.prepared.release();
    await host.processes.dispose();
  }
}

async function readText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return result + decoder.decode();
      result += decoder.decode(item.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
