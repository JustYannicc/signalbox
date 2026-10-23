// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelCommandExit } from "../../kernel/KernelCommandForwarder.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { isStoppedWorkerLoaderQuotaFailure } from "../ChildWorkerDispatchError.ts";
import { createChildBash } from "../ChildBash.ts";
import { createChildBashForkDispatch } from "../ChildBashForkDispatch.ts";
import { createWorkerLoaderDispatch } from "../WorkerLoaderDispatch.ts";
import { ChildWorkerLifetimes } from "../ChildWorkerLifetimes.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error("Required GNU Bash artifact is missing");
const module = available
  ? (() => {
      const bytes = NodeFS.readFileSync(artifact);
      if (
        bytes.byteLength !== KERNEL_BASH_ARTIFACT.bytes ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
      )
        throw new Error("GNU Bash artifact does not match its pin");
      return new WebAssembly.Module(bytes);
    })()
  : undefined;

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const quotaCases = [
  {
    label: "10",
    message:
      "Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.",
  },
  {
    label: "4",
    message:
      "Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations. Wait for one to finish before starting another.",
  },
] as const;

type DispatchOutcome =
  | { readonly kind: "quota"; readonly message: string }
  | { readonly kind: "memory" }
  | { readonly kind: "success" };

function workerForkHarness(owner: string, initialOutcome: DispatchOutcome) {
  const capacity = new ChildWorkerCapacity(1, { owner });
  const lifetimes = new ChildWorkerLifetimes();
  const loaderIds: string[] = [];
  const quotaClassifications: boolean[] = [];
  const isStoppedQuotaFailure = (error: unknown) => {
    const result = isStoppedWorkerLoaderQuotaFailure(error);
    quotaClassifications.push(result);
    return result;
  };
  let attempt = 0;
  let outcome = initialOutcome;

  const get = vi.fn<WorkerLoader["get"]>().mockImplementation((id, createCode) => {
    loaderIds.push(String(id));
    const code = createCode();
    if (code instanceof Promise) throw new Error("Unexpected asynchronous worker code factory");

    const entrypoint = {
      [Symbol.dispose]: vi.fn(),
      async run(_command: unknown, target: unknown): Promise<KernelCommandExit> {
        attempt++;
        if (outcome.kind === "quota") throw new Error(outcome.message);

        const invocation = target as { host(): unknown; stopped(): void };
        const host = invocation.host() as {
          forkSnapshot(): { restored(): Promise<void> } | undefined;
        };
        const snapshot = host.forkSnapshot();
        if (snapshot === undefined) throw new Error("Fork snapshot is unavailable");
        await snapshot.restored();

        if (outcome.kind === "memory") throw new Error("Worker exceeded memory limit");
        invocation.stopped();
        return exited();
      },
    };
    const worker = {
      [Symbol.dispose]: vi.fn(),
      getEntrypoint: vi.fn(() => entrypoint),
      getDurableObjectClass: vi.fn(),
    };
    return worker as unknown as WorkerStub;
  });
  const dispatch = createWorkerLoaderDispatch<KernelBashPort>({ get, load: vi.fn() });
  const runFork = createChildBashForkDispatch({
    credentials: bashCredentials,
    code: { mainModule: "main.js", modules: { "main.js": "export default {}" } },
    capacity,
    lifetimes,
    dispatch,
  });

  return {
    capacity,
    lifetimes,
    loaderIds,
    quotaClassifications,
    isStoppedQuotaFailure,
    runFork,
    attempts: () => attempt,
    setOutcome(next: DispatchOutcome) {
      outcome = next;
    },
  };
}

function startGuest(
  fixture: ReturnType<typeof childBashFixture>,
  runFork: NonNullable<Parameters<typeof createKernelBashHost>[0]["runFork"]>,
  isStoppedQuotaFailure: (error: unknown) => boolean,
) {
  const owner = createKernelBashHost({
    context: fixture.context,
    credentials: bashCredentials,
    runFork,
    isStoppedQuotaFailure,
  });
  const reactor = createChildBash({
    module: module!,
    credentials: bashCredentials,
    pid: owner.pid,
    port: owner.port,
    args: fixture.context.args,
    env: fixture.context.env,
    residentWasmBudgetBytes: 0,
  });
  return { owner, reactor };
}

describe.skipIf(!available)("Bash Dynamic Worker quota fork failure", () => {
  it.each(quotaCases)(
    "reports a normal failed fork, releases the slot, and reuses its generation after the $label cap",
    async ({ message, label }) => {
      const command = ["bash", "-c", 'printf "before|"; (exit 0) & printf "after"'];
      const harness = workerForkHarness(`test/bash-quota-${label}`, { kind: "quota", message });
      const fixture = childBashFixture({ args: command });
      const guest = startGuest(fixture, harness.runFork, harness.isStoppedQuotaFailure);
      const initialDescriptors = [...fixture.filesystem.descriptors.entries()].map(([fd]) => fd);
      const waitpid = vi.spyOn(fixture.processes, "waitpid");

      const control = childBashFixture({ args: command });
      const reference = createChildBash({
        module: module!,
        credentials: bashCredentials,
        pid: control.owner.pid,
        port: {
          ...control.owner.port,
          async fork() {
            return { kind: "error" as const, errno: 6 };
          },
        },
        args: control.context.args,
        env: control.context.env,
      });

      try {
        const expected = await reference.run();
        await reference.drain();
        expect([...control.filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(
          initialDescriptors,
        );

        const actual = await guest.reactor.run();
        await guest.reactor.drain();
        await harness.lifetimes.drain();

        const failedForkAttempts = harness.attempts();
        expect(failedForkAttempts).toBeGreaterThan(1);
        expect(harness.quotaClassifications.length).toBeGreaterThanOrEqual(failedForkAttempts);
        expect(harness.quotaClassifications.every(Boolean)).toBe(true);
        expect(fixture.stdout()).toBe(control.stdout());
        expect(fixture.stderr()).toBe(control.stderr());
        expect(fixture.stderr()).toContain("fork:");
        expect(actual).toEqual(expected);
        expect(fixture.processes.size).toBe(1);
        expect([...fixture.filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(
          initialDescriptors,
        );
        expect(fixture.wakes.size).toBe(0);
        expect(harness.capacity.active).toBe(0);
        expect(harness.capacity.waiting).toBe(0);
        expect(harness.capacity.failure).toBeUndefined();
        const childStatuses = waitpid.mock.results
          .map((result) => result.value)
          .filter((result) => result.status === "ok" && result.value.pid > 0)
          .map((result) => result.value.status);
        expect(childStatuses).toEqual(Array.from({ length: failedForkAttempts }, () => exited()));

        const nextFixture = childBashFixture({
          args: ["bash", "-c", '(exit 0) & pid=$!; wait "$pid"; printf "next"'],
        });
        const nextDescriptors = [...nextFixture.filesystem.descriptors.entries()].map(([fd]) => fd);
        harness.setOutcome({ kind: "success" });
        const nextGuest = startGuest(nextFixture, harness.runFork, harness.isStoppedQuotaFailure);
        try {
          await expect(nextGuest.reactor.run()).resolves.toEqual(exited());
          await nextGuest.reactor.drain();
          await harness.lifetimes.drain();
          expect(nextFixture.stdout()).toBe("next");
          expect(nextFixture.processes.size).toBe(1);
          expect([...nextFixture.filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(
            nextDescriptors,
          );
          expect(nextFixture.wakes.size).toBe(0);
          expect(harness.capacity.active).toBe(0);
          expect(harness.attempts()).toBe(failedForkAttempts + 1);
          expect(harness.loaderIds).toHaveLength(failedForkAttempts + 1);
          expect(new Set(harness.loaderIds).size).toBe(1);
        } finally {
          await nextGuest.owner.close();
          await nextFixture.close();
        }
      } finally {
        await guest.owner.close();
        await fixture.close();
        await control.close();
        await harness.lifetimes.drain();
      }
    },
  );

  it("keeps a genuine memory failure visible as SIGKILL after restore", async () => {
    const fixture = childBashFixture({
      args: ["bash", "-c", '(exit 0) & pid=$!; wait "$pid"; printf "wait:%s|alive" "$?"'],
    });
    const harness = workerForkHarness("test/bash-memory-sigkill", { kind: "memory" });
    const guest = startGuest(fixture, harness.runFork, harness.isStoppedQuotaFailure);
    const waitpid = vi.spyOn(fixture.processes, "waitpid");
    const initialDescriptors = [...fixture.filesystem.descriptors.entries()].map(([fd]) => fd);

    try {
      await expect(guest.reactor.run()).resolves.toEqual(exited());
      await guest.reactor.drain();
      await harness.lifetimes.drain();
      expect(fixture.stdout()).toBe("wait:137|alive");
      expect(fixture.processes.size).toBe(1);
      expect([...fixture.filesystem.descriptors.entries()].map(([fd]) => fd)).toEqual(
        initialDescriptors,
      );
      const childStatuses = waitpid.mock.results
        .map((result) => result.value)
        .filter((result) => result.status === "ok" && result.value.pid > 0)
        .map((result) => result.value.status);
      expect(childStatuses).toEqual([{ exitCode: 0, signal: 9, coreDumped: false }]);
    } finally {
      await guest.owner.close();
      await fixture.close();
      await harness.lifetimes.drain();
    }
  });
});
