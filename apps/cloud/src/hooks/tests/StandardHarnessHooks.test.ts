import { RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HarnessHookJson, HarnessHookRequest } from "../HarnessHooks.ts";
import {
  createStandardHarnessHookCallback,
  type StandardHarnessHookPorts,
} from "../StandardHarnessHooks.ts";
import type {
  ThreadHarnessActiveAttempt,
  ThreadHarnessHookContext,
} from "../ThreadHarnessHooks.ts";

const threadId = ThreadId.make("thread:standard-hooks");
const attempt: ThreadHarnessActiveAttempt = {
  threadId,
  runId: RunId.make("run:standard-hooks"),
  attemptId: RunAttemptId.make("attempt:standard-hooks"),
  generation: 4,
};

type Adapter = {
  activeAttempt: ThreadHarnessActiveAttempt | null;
  readonly resolvedPoolId: string;
  readonly statusNotes: Map<string, string>;
  readonly modelRequests: { readonly poolId: string; readonly model: "small" }[];
  readonly settledEvents: { readonly type: "thread.turn-settled"; readonly attemptKey: string }[];
  readonly settledKeys: Set<string>;
  readonly registeredSecrets: Map<string, string>;
  readonly preparedInputs: string[];
  readonly scrubbedOutputs: string[];
  readonly preRequests: HarnessHookRequest[];
  readonly postRequests: HarnessHookRequest[];
  statusFailure: Error | undefined;
  scrubberReady: boolean;
};

const attemptKey = (value: ThreadHarnessActiveAttempt) =>
  `${value.threadId}/${value.runId}/${value.attemptId}/${value.generation}`;

function createAdapter(): Adapter {
  return {
    activeAttempt: attempt,
    resolvedPoolId: "pool:thread-resolved",
    statusNotes: new Map(),
    modelRequests: [],
    settledEvents: [],
    settledKeys: new Set(),
    registeredSecrets: new Map([["API_TOKEN", "test-secret-value"]]),
    preparedInputs: [],
    scrubbedOutputs: [],
    preRequests: [],
    postRequests: [],
    statusFailure: undefined,
    scrubberReady: true,
  };
}

function assertCurrent(adapter: Adapter, context: ThreadHarnessHookContext): string {
  context.signal.throwIfAborted();
  const supplied = context.authority.activeAttempt;
  if (supplied === null || adapter.activeAttempt === null) {
    throw new Error("A current attempt is required for this effect.");
  }
  const key = attemptKey(supplied);
  if (key !== attemptKey(adapter.activeAttempt)) throw new Error("Stale hook attempt.");
  return key;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, HarnessHookJson>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statefulPorts(adapter: Adapter): StandardHarnessHookPorts {
  return {
    thread: {
      async ensureTurnStatus(context) {
        const key = assertCurrent(adapter, context);
        if (adapter.statusNotes.has(key)) return;
        adapter.modelRequests.push({ poolId: adapter.resolvedPoolId, model: "small" });
        if (adapter.statusFailure) throw adapter.statusFailure;
        assertCurrent(adapter, context);
        adapter.statusNotes.set(key, "next: verify the result");
      },
    },
    gateway: {
      async beforeToolUse(context) {
        assertCurrent(adapter, context);
        adapter.preRequests.push(context.request);
        const payload = context.request.payload;
        if (!isJsonObject(payload)) throw new Error("Tool input is missing.");
        const input = payload["tool_input"];
        if (!isJsonObject(input)) throw new Error("Tool input is missing.");
        const command = input["command"];
        if (typeof command !== "string") throw new Error("Tool command is missing.");
        const prepared = command.replaceAll(/\{\{secret:([^}]+)\}\}/g, (_match, name: string) => {
          const secret = adapter.registeredSecrets.get(name);
          if (secret === undefined) throw new Error("Unregistered secret placeholder.");
          return secret;
        });
        if (/\{\{secret:[^}]+\}\}/.test(prepared)) {
          throw new Error("Unregistered secret placeholder.");
        }
        adapter.preparedInputs.push(prepared);
      },
      async afterToolUse(context) {
        assertCurrent(adapter, context);
        adapter.postRequests.push(context.request);
        if (!adapter.scrubberReady) throw new Error("The model-wire scrubber is unavailable.");
        const payload = context.request.payload;
        if (!isJsonObject(payload)) throw new Error("Tool output is missing.");
        const output = payload["tool_response"];
        if (typeof output !== "string") throw new Error("Tool output is missing.");
        let scrubbed = output;
        for (const [name, secret] of adapter.registeredSecrets) {
          scrubbed = scrubbed.replaceAll(secret, `{{secret:${name}}}`);
        }
        assertCurrent(adapter, context);
        adapter.scrubbedOutputs.push(scrubbed);
      },
    },
    automations: {
      async turnSettled(context) {
        const key = assertCurrent(adapter, context);
        if (adapter.settledKeys.has(key)) return;
        adapter.settledKeys.add(key);
        adapter.settledEvents.push({ type: "thread.turn-settled", attemptKey: key });
      },
    },
  };
}

function callback(adapter: Adapter, ports = statefulPorts(adapter)) {
  return createStandardHarnessHookCallback(
    { threadId, activeAttempt: () => adapter.activeAttempt },
    ports,
  );
}

async function rejectStopBeforeCommit(
  adapter: Adapter,
  invalidate: (adapter: Adapter, controller: AbortController) => void,
  message: string,
): Promise<void> {
  const started = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const controller = new AbortController();
  const ports: StandardHarnessHookPorts = {
    ...statefulPorts(adapter),
    thread: {
      async ensureTurnStatus(context) {
        started.resolve();
        await commit.promise;
        assertCurrent(adapter, context);
      },
    },
  };
  const pending = callback(adapter, ports)(request("stop"), { signal: controller.signal });
  await started.promise;
  invalidate(adapter, controller);
  commit.resolve();

  await expect(pending).rejects.toMatchObject({ message });
  expect(adapter.modelRequests).toEqual([]);
  expect(adapter.settledEvents).toEqual([]);
}

function request(
  event: HarnessHookRequest["event"],
  payload: HarnessHookJson = { hook_event_name: event, future_field: { preserved: true } },
): HarnessHookRequest {
  return {
    harness: "claude-code",
    event,
    sessionId: "session:official-input",
    turnId: "turn:official-input",
    toolCallId: `tool:${event}`,
    payload,
  };
}

const signal = () => new AbortController().signal;

describe("standard harness hooks", () => {
  it("does nothing for SessionStart without an active attempt", async () => {
    const adapter = createAdapter();
    adapter.activeAttempt = null;

    await expect(
      callback(adapter)(request("session-start"), { signal: signal() }),
    ).resolves.toEqual({});
    expect(adapter.modelRequests).toEqual([]);
    expect(adapter.preRequests).toEqual([]);
    expect(adapter.postRequests).toEqual([]);
    expect(adapter.settledEvents).toEqual([]);
  });

  it("reuses an existing status note and publishes one settled event across repeated Stop hooks", async () => {
    const adapter = createAdapter();
    adapter.statusNotes.set(attemptKey(attempt), "already written");
    const dispatch = callback(adapter);
    const stop = request("stop");

    const results = await Promise.all([
      dispatch(stop, { signal: signal() }),
      dispatch(stop, { signal: signal() }),
    ]);

    expect(results).toEqual([{}, {}]);
    expect(adapter.modelRequests).toEqual([]);
    expect(adapter.settledEvents).toEqual([
      { type: "thread.turn-settled", attemptKey: attemptKey(attempt) },
    ]);
  });

  it("writes a missing status note with the small model on the thread's resolved pool once", async () => {
    const adapter = createAdapter();
    const dispatch = callback(adapter);

    await dispatch(request("stop"), { signal: signal() });
    await dispatch(request("stop"), { signal: signal() });

    expect(adapter.modelRequests).toEqual([{ poolId: "pool:thread-resolved", model: "small" }]);
    expect(adapter.statusNotes.get(attemptKey(attempt))).toBe("next: verify the result");
    expect(adapter.settledEvents).toHaveLength(1);
  });

  it("does not publish a settled event when Thread cannot write the fallback status", async () => {
    const adapter = createAdapter();
    adapter.statusFailure = new Error("status model unavailable");

    await expect(callback(adapter)(request("stop"), { signal: signal() })).rejects.toThrow(
      "status model unavailable",
    );
    expect(adapter.settledEvents).toEqual([]);
  });

  it("routes complete official tool requests through Gateway and returns no secret values", async () => {
    const adapter = createAdapter();
    const dispatch = callback(adapter);
    const pre = request("pre-tool-use", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "send {{secret:API_TOKEN}}", future_field: ["keep"] },
    });
    const post = request("post-tool-use", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: "tool returned test-secret-value",
      future_field: { keep: true },
    });

    const results = await Promise.all([
      dispatch(pre, { signal: signal() }),
      dispatch(post, { signal: signal() }),
    ]);

    expect(adapter.preRequests[0]).toBe(pre);
    expect(adapter.postRequests[0]).toBe(post);
    expect(adapter.preparedInputs).toEqual(["send test-secret-value"]);
    expect(adapter.scrubbedOutputs).toEqual(["tool returned {{secret:API_TOKEN}}"]);
    expect(JSON.stringify(results)).not.toContain("test-secret-value");
  });

  it("fails closed when the model-wire scrubber is unavailable", async () => {
    const adapter = createAdapter();
    adapter.scrubberReady = false;

    await expect(
      callback(adapter)(
        request("post-tool-use", { hook_event_name: "PostToolUse", tool_response: "output" }),
        { signal: signal() },
      ),
    ).rejects.toThrow("model-wire scrubber is unavailable");
    expect(adapter.scrubbedOutputs).toEqual([]);
  });

  it("rejects missing or cross-thread run authority before calling an owning port", async () => {
    const inactive = createAdapter();
    inactive.activeAttempt = null;
    await expect(callback(inactive)(request("stop"), { signal: signal() })).rejects.toThrow(
      "active thread attempt",
    );

    const foreign = createAdapter();
    foreign.activeAttempt = {
      ...attempt,
      threadId: ThreadId.make("thread:foreign"),
    };
    await expect(callback(foreign)(request("stop"), { signal: signal() })).rejects.toThrow(
      "belongs to another thread",
    );
    expect(foreign.modelRequests).toEqual([]);
    expect(foreign.settledEvents).toEqual([]);
  });

  it("rejects stale attempts and cancellation before the owning Thread port commits", async () => {
    const stale = createAdapter();
    await rejectStopBeforeCommit(
      stale,
      (adapter) => {
        adapter.activeAttempt = { ...attempt, generation: 5 };
      },
      "Stale hook attempt.",
    );

    const cancelled = createAdapter();
    await rejectStopBeforeCommit(
      cancelled,
      (_adapter, controller) => controller.abort(new Error("hook cancelled")),
      "hook cancelled",
    );
  });
});
