// @effect-diagnostics globalTimers:off - deadlines report failed guest progress or cleanup.
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import type { createBashGateway } from "./ChildBashGatewayFixture.ts";

const bashArgs = (script: string) => ["bash", "--noprofile", "--norc", "-c", script];

export function publicCommand(
  gateway: ReturnType<typeof createBashGateway>,
  script: string,
  signal: AbortSignal = gateway.fixture.controller.signal,
) {
  return gateway.fixture.gateway.exec(
    {
      executable: "/bin/bash",
      argv: bashArgs(script),
      cwd: "/workspace",
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    },
    signal,
    undefined,
  );
}

export function captureText(stream: ReadableStream<Uint8Array>) {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const settled = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  })();
  return { settled, text: () => chunks.join("") };
}

export function captureCapacityPressure(gateway: ReturnType<typeof createBashGateway>) {
  return gateway.fixture.capacity.onPressure((pressure) => {
    gateway.forkTrace.push({ event: "capacity-pressure", ...pressure });
  });
}

export function gatewayTrace(gateway: ReturnType<typeof createBashGateway>) {
  return JSON.stringify(
    {
      active: gateway.fixture.capacity.active,
      waiting: gateway.fixture.capacity.waiting,
      processes: gateway.fixture.context.processes.size,
      events: gateway.forkTrace.slice(-24),
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

export async function cleanupGatewayCommand(
  gateway: ReturnType<typeof createBashGateway>,
  child: KernelCommandChild | undefined,
  controller: AbortController,
  cancel: boolean,
) {
  const failures: unknown[] = [];
  if (cancel) {
    try {
      controller.abort();
    } catch (error) {
      failures.push(error);
    }
  }
  const results = await within(
    Promise.allSettled([child?.dispose(), gateway.fixture.close()]),
    10_000,
  );
  if (results.kind === "deadline") {
    failures.push(new Error(`Bash gateway cleanup timed out; ${gatewayTrace(gateway)}`));
  } else if (results.kind === "completed") {
    failures.push(
      ...results.value.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
  }
  if (failures.length > 0) throw new AggregateError(failures, "Bash gateway cleanup failed");
}

export async function withFailurePreservingCleanup<T>(
  body: () => Promise<T>,
  cleanup: (bodyFailed: boolean) => Promise<void>,
): Promise<T> {
  let value!: T;
  let bodyFailed = false;
  let primaryFailure: unknown;
  try {
    value = await body();
  } catch (error) {
    bodyFailed = true;
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await cleanup(bodyFailed);
  } catch (error) {
    cleanupFailure = error;
  }

  if (bodyFailed && cleanupFailure !== undefined)
    throw new AggregateError([primaryFailure, cleanupFailure], "Bash command and cleanup failed");
  if (bodyFailed) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return value;
}

export async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), milliseconds);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
