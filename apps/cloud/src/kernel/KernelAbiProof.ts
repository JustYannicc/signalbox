import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  attemptKernelOperation,
  callKernel,
  kernelOk,
} from "./KernelAbi.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Runs unchanged in a Durable Object fixture; no Node or test-runner dependencies. */
export async function runKernelAbiProof() {
  const checks: { name: string; ok: boolean; error?: string }[] = [];
  const run = async (name: string, check: () => void | Promise<void>) => {
    try {
      await check();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await run("wake before wait", async () => {
    const wakes = new KernelWakeRegistry();
    let wake = () => {};
    let detached = 0;
    try {
      const result = attemptKernelOperation(
        wakes,
        (notify) => {
          wake = notify;
          return () => {
            detached++;
          };
        },
        () => {
          wake();
          return { status: "would_block" };
        },
      );
      assert(result.status === "would_block", "Operation must return its wake token");
      assert((await wakes.wait(result.wakeToken)).status === "ok", "Early wake was lost");
      assert(wakes.size === 0 && detached === 1, "Consumed notification leaked");
      assert((await wakes.wait(result.wakeToken)).status === "error", "Token was consumed twice");
    } finally {
      wakes.dispose();
    }
  });

  await run("request cancellation cleanup", async () => {
    const wakes = new KernelWakeRegistry();
    const request = new AbortController();
    let detached = 0;
    try {
      const token = wakes.register(() => () => {
        detached++;
      });
      assert(token.status === "ok", "Could not register notification");
      const waiting = wakes.wait(token.value, request.signal);
      request.abort();
      const result = await waiting;
      assert(
        result.status === "error" && result.error.code === "CANCELLED",
        "Request did not cancel wait",
      );
      assert(wakes.size === 0 && detached === 1, "Cancelled request leaked its subscription");
    } finally {
      wakes.dispose();
    }
  });

  await run("program version pin and ABI mismatch", () => {
    const programs = new KernelProgramRegistry();
    const first = {
      name: "tool",
      version: "1.0.0",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: "tool-v1",
    };
    assert(programs.register(first).status === "ok", "Could not register first version");
    assert(
      programs.register({ ...first, version: "2.0.0", entrypoint: "tool-v2" }).status === "ok",
      "Could not register second version",
    );
    const pinned = programs.resolve("tool", "1.0.0", [ABI_VERSION], {});
    assert(
      pinned.status === "ok" && pinned.value.entrypoint === "tool-v1",
      "Version pin resolved another program",
    );
    const mismatch = programs.resolve("tool", "1.0.0", [0], {});
    assert(
      mismatch.status === "error" && mismatch.error.code === "ABI_MISMATCH",
      "v0 was falsely supported",
    );
    const unknown = programs.resolve("tool", "latest", [ABI_VERSION], {});
    assert(
      unknown.status === "error" && unknown.error.code === "NOT_FOUND",
      "Unregistered version resolved",
    );
  });

  await run("unsupported capability rejection", () => {
    const programs = new KernelProgramRegistry();
    programs.register({
      name: "tool",
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: ["process.wait"],
      entrypoint: "tool",
    });
    const missing = programs.resolve("tool", "1", [ABI_VERSION], {});
    assert(
      missing.status === "error" && missing.error.code === "UNSUPPORTED",
      "Missing required capability was accepted",
    );
    const backend = { "process.wait": () => kernelOk({ exitCode: 0 }) };
    assert(
      programs.resolve("tool", "1", [ABI_VERSION], backend).status === "ok",
      "Implemented capability was rejected",
    );
    const call = callKernel({}, "escalate", {
      reason: "needs a machine",
      capability: "native-process",
    });
    assert(
      !(call instanceof Promise) && call.status === "error" && call.error.code === "UNSUPPORTED",
      "Missing operation pretended to succeed",
    );
  });

  return { ok: checks.every((check) => check.ok), checks };
}
