import { describe, expect, it, vi } from "vite-plus/test";
import type { SeededChildProgramCatalogOptions } from "../childPrograms/runtime.ts";
import { ABI_VERSION } from "../../src/kernel/KernelAbi.ts";
import type { KernelAsyncProgramContext } from "../../src/kernel/KernelAsyncProgram.ts";
import type { KernelProgramBinding } from "../../src/kernel/KernelProgramHost.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createKernelProcessStreams } from "../../src/kernel/KernelProcessStreams.ts";
import {
  createChildWorkerProgram,
  type ChildWorkerProgram,
} from "../../src/computer/ChildWorkerProgram.ts";
import type { KernelCommandForwarder } from "../../src/kernel/KernelCommandForwarder.ts";
import { EXPECTED_STDOUT, INITIAL_FILE, RESULT_FILE, runProofCommand } from "./Command.ts";
import { NESTED_NATIVE_SCRIPT, NESTED_PROOF_COMMAND } from "./NestedCommand.ts";
import { LOCAL_CAT_COMMAND } from "./LocalOnlyControl.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";

const observed = vi.hoisted(() => ({
  contexts: [] as { admission: object | undefined; pid: number }[],
  rootBodyRuns: 0,
}));

async function emit(context: KernelAsyncProgramContext, out: Uint8Array, err = new Uint8Array()) {
  const streams = createKernelProcessStreams(context.filesystem, { signal: context.signal });
  const stdout = streams.stdout.getWriter();
  const stderr = streams.stderr.getWriter();
  await stdout.write(out);
  if (err.length) await stderr.write(err);
  stdout.releaseLock();
  stderr.releaseLock();
}

// Fake child bodies; admission, grant claims, exec replacement, descriptors and lifetimes are real.
vi.mock("../childPrograms/runtime.ts", () => ({
  createSeededChildProgramCatalog(options: SeededChildProgramCatalogOptions) {
    const binding = (
      name: string,
      run: (context: KernelAsyncProgramContext) => Promise<{
        exitCode: number;
        signal: number;
        coreDumped: boolean;
      }>,
    ): KernelProgramBinding => {
      const program: ChildWorkerProgram = createChildWorkerProgram({
        executable: `/bin/${name}`,
        code: { mainModule: "fake-body", modules: {} },
        capacity: options.capacity,
        ...(options.lifetimes === undefined ? {} : { lifetimes: options.lifetimes }),
        ...(options.reservationFor === undefined
          ? {}
          : {
              reservationFor: (context) => options.reservationFor!(context, program),
            }),
        createHost: (context) => ({ host: context, close: () => {} }),
        dispatch: {
          run: async (_input, context) => {
            observed.contexts.push({ admission: context.admission, pid: context.identity.pid });
            return run(context);
          },
        },
      });
      const manifest = {
        name,
        version: "1",
        abiVersion: ABI_VERSION,
        requiredCapabilities: [],
        entrypoint: name,
      };
      if (options.registry.register(manifest).status !== "ok")
        throw new Error("Fixture registration failed");
      return { manifest, implementation: program };
    };
    const root = binding("bash", async (context) => {
      observed.rootBodyRuns++;
      const localCat = context.args.at(-1) === LOCAL_CAT_COMMAND.argv.at(-1);
      const nested = context.args.at(-1) === NESTED_PROOF_COMMAND.argv.at(-1);
      if (localCat || nested)
        return context.exec({
          filesystem: context.filesystem,
          identity: context.identity,
          path: localCat ? "/bin/cat" : "/bin/sh",
          args: localCat
            ? ["/bin/cat", "out.bin"]
            : ["/bin/sh", "-c", NESTED_NATIVE_SCRIPT, "nested sh identity"],
          env: context.env,
          signal: context.signal,
          ...(context.home === undefined ? {} : { home: context.home }),
        });
      const streams = createKernelProcessStreams(context.filesystem, { signal: context.signal });
      const chunks: number[] = [];
      for await (const bytes of streams.stdin) chunks.push(...bytes);
      expect(new TextDecoder().decode(new Uint8Array(chunks))).toBe("input 雪\n");
      const fd = context.filesystem.open(
        "/workspace/out.bin",
        KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
      );
      context.filesystem.write(fd, RESULT_FILE, null);
      context.filesystem.close(fd);
      await emit(context, EXPECTED_STDOUT, new Uint8Array([128, 0]));
      return { exitCode: 17, signal: 0, coreDumped: false };
    });
    const cat = binding("cat", async (context) => {
      const fd = context.filesystem.open("/workspace/out.bin", KernelOpenFlags.O_RDONLY);
      const bytes = new Uint8Array(INITIAL_FILE.length);
      context.filesystem.read(fd, bytes, 0n);
      context.filesystem.close(fd);
      await emit(context, bytes);
      return { exitCode: 0, signal: 0, coreDumped: false };
    });
    return {
      bindings: new Map([
        ["/bin/bash", root],
        ["/bin/cat", cat],
      ]),
    };
  },
}));

import { proofKernel } from "./Kernel.ts";

function fixture() {
  observed.contexts.length = 0;
  observed.rootBodyRuns = 0;
  const sql = sqliteFixture();
  const code = { mainModule: "fake-body", modules: {} };
  const kernel = proofKernel(sql.storage, {} as WorkerLoader, {
    sourceCommit: "0".repeat(40),
    runner: { bytes: new Uint8Array(), sha256: "fake-body" },
    programs: { bash: code, busyboxCat: code, ripgrep: code },
    executables: [],
  });
  return {
    kernel,
    async close() {
      await kernel.close();
      sql.close();
    },
  };
}

describe("proof admitted composition with fake child bodies, not native qualification", () => {
  it("keeps local root and cat replacement admitted despite the normal machine rule", async () => {
    const test = fixture();
    try {
      expect(await test.kernel.localControl(new AbortController().signal)).toEqual({
        localOnlyRootAndDescendantAdmitted: true,
        localOnlyNormalMachineRuleOverridden: true,
        localOnlyUnsupportedRejected: true,
        localOnlyZeroForwards: true,
        localOnlyPhysicalCapacityDrained: true,
      });
      expect(observed.contexts).toHaveLength(3);
      expect(observed.contexts.every((context) => context.admission !== undefined)).toBe(true);
      expect(observed.contexts[1]?.pid).toBe(observed.contexts[2]?.pid);
      expect(observed.contexts[1]?.admission).not.toBe(observed.contexts[2]?.admission);
      expect(test.kernel.admissionSnapshot()).toEqual({
        normal: { rootRequests: 0, rootClaims: 0, descendantClaims: 0, forwards: 0 },
        local: { rootRequests: 3, rootClaims: 2, descendantClaims: 1, forwards: 0 },
        fallbackRuns: 0,
        active: 0,
      });
      expect(test.kernel.host.processes.size).toBe(0);
    } finally {
      await test.close();
    }
  });

  it("claims the normal root grant once and forwards only its raw descendant", async () => {
    const test = fixture();
    const spawn = vi.fn<KernelCommandForwarder["spawn"]>(async () => ({
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(EXPECTED_STDOUT);
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([128, 0]));
          controller.close();
        },
      }),
      exited: Promise.resolve({ exitCode: 17, signal: 0, coreDumped: false }),
      signal: async () => ({ status: "ok", value: undefined }),
      dispose: async () => {},
    }));
    try {
      await test.kernel.localControl(new AbortController().signal);
      observed.rootBodyRuns = 0;
      test.kernel.bindNestedMachine({ spawn });
      await runProofCommand(
        await test.kernel.commands.exec(NESTED_PROOF_COMMAND, new AbortController().signal),
      );
      expect(await test.kernel.settledDiagnostics()).toEqual({
        admittedPhysicalCapacityDrained: true,
      });
      expect(test.kernel.admissionDiagnostics()).toEqual({
        admittedRootGrantClaimedExactlyOnce: true,
        admittedCatalogNoFallbackCapacityRun: true,
        admittedNestedForwardExactlyOnce: true,
      });
      expect(observed.rootBodyRuns).toBe(1);
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        {
          executable: "/bin/sh",
          argv: ["/bin/sh", "-c", NESTED_NATIVE_SCRIPT, "nested sh identity"],
          cwd: NESTED_PROOF_COMMAND.cwd,
          env: NESTED_PROOF_COMMAND.env,
        },
        expect.any(AbortSignal),
      );
      expect(test.kernel.host.processes.size).toBe(0);
    } finally {
      await test.close();
    }
  });
});
