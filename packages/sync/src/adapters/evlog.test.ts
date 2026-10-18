import { describe, expect, it } from "vite-plus/test";
import type { DrainContext, DrainFn } from "evlog";
import type { ObservabilityEvent, SpanEvent } from "lunorash/runtime";

import { createEvlogObservabilitySink } from "@signalbox/sync/adapters/evlog";

const drainThat = (write: (context: DrainContext) => void | Promise<void>): DrainFn => {
  const drain = async (contexts: DrainContext | DrainContext[]) => {
    for (const context of Array.isArray(contexts) ? contexts : [contexts]) {
      await write(context);
    }
  };
  return Object.assign(drain, { raw: drain });
};

const rpc = (overrides: Partial<ObservabilityEvent> = {}): ObservabilityEvent => ({
  durationMs: 24,
  functionPath: "notes:list",
  ok: true,
  parentSpanId: "parent-span",
  shardKey: "folder:one",
  spanId: "rpc-span",
  traceFlags: 1,
  traceId: "trace-one",
  ...overrides,
});

const span = (overrides: Partial<SpanEvent> = {}): SpanEvent => ({
  attributes: { "db.operation": "select", "db.system": "sqlite" },
  durationMs: 9,
  functionPath: "notes:list",
  kind: "internal",
  name: "notes.read",
  ok: true,
  parentSpanId: "rpc-span",
  sampled: true,
  shardKey: "folder:one",
  spanId: "span-one",
  startTs: 100,
  traceId: "trace-one",
  ...overrides,
});

describe("createEvlogObservabilitySink", () => {
  it("drains one safe successful RPC event through waitUntil", async () => {
    const delivered: DrainContext[] = [];
    const drain = drainThat((context) => {
      delivered.push(context);
    });
    const pending: Promise<unknown>[] = [];
    const sink = createEvlogObservabilitySink(drain);

    sink.onRpc?.(rpc({ host: "private.example", userAgent: "private-agent" }), {
      waitUntil: (promise) => pending.push(promise),
    });

    expect(pending).toHaveLength(1);
    await pending[0];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.event).toMatchObject({
      durationMs: 24,
      level: "info",
      outcome: "success",
      rpc: {
        functionPath: "notes:list",
        shardKey: "folder:one",
      },
      trace: { flags: 1, id: "trace-one", parentSpanId: "parent-span", spanId: "rpc-span" },
    });
    expect(JSON.stringify(delivered[0]?.event)).not.toContain("private.example");
    expect(JSON.stringify(delivered[0]?.event)).not.toContain("private-agent");
    expect(delivered[0]?.request).toBeUndefined();
  });

  it("keeps failure details structured without exporting handler input or stack", async () => {
    const delivered: DrainContext[] = [];
    const pending: Promise<unknown>[] = [];
    const sink = createEvlogObservabilitySink(
      drainThat((context) => {
        delivered.push(context);
      }),
    );

    sink.onRpc?.(
      rpc({
        error: {
          code: "FUNCTION_FAILED",
          message: "secret payload from a handler",
          name: "HandlerFailure",
          stack: "secret stack frame",
          status: 422,
        },
        ok: false,
      }),
      { waitUntil: (promise) => pending.push(promise) },
    );

    expect(pending).toHaveLength(1);
    await pending[0];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.event).toMatchObject({
      durationMs: 24,
      level: "error",
      error: { code: "FUNCTION_FAILED", status: 422 },
      outcome: "failure",
      rpc: { functionPath: "notes:list", shardKey: "folder:one" },
    });
    const output = JSON.stringify(delivered[0]?.event);
    expect(output).not.toContain("secret payload");
    expect(output).not.toContain("secret stack");
    expect(output).not.toContain("HandlerFailure");
  });

  it("writes separate correlated trace span events and omits synthetic dispatch spans", async () => {
    const delivered: DrainContext[] = [];
    const pending: Promise<unknown>[] = [];
    const sink = createEvlogObservabilitySink(
      drainThat((context) => {
        delivered.push(context);
      }),
    );
    const waitUntil = (promise: Promise<unknown>) => pending.push(promise);

    sink.onRpc?.(rpc(), { waitUntil });
    sink.onSpan?.(span(), { waitUntil });
    sink.onSpan?.(span({ dispatch: true, name: "dispatch" }), { waitUntil });
    await Promise.all(pending);

    expect(delivered).toHaveLength(2);
    expect(delivered.map(({ event }) => event.eventType)).toEqual(["rpc", "span"]);
    expect(delivered[1]?.event).toMatchObject({
      durationMs: 9,
      level: "info",
      eventType: "span",
      functionPath: "notes:list",
      outcome: "success",
      span: {
        attributes: { "db.operation": "select", "db.system": "sqlite" },
        id: "span-one",
        kind: "internal",
        name: "notes.read",
        parentSpanId: "rpc-span",
        sampled: true,
        shardKey: "folder:one",
        status: { code: "ok" },
        traceId: "trace-one",
      },
    });
  });

  it("marks a failed span and keeps the error type without the message", async () => {
    const delivered: DrainContext[] = [];
    const pending: Promise<unknown>[] = [];
    const sink = createEvlogObservabilitySink(
      drainThat((context) => {
        delivered.push(context);
      }),
    );

    sink.onSpan?.(
      span({
        error: { message: "private prompt text", type: "ValidationError" },
        ok: false,
      }),
      { waitUntil: (promise) => pending.push(promise) },
    );
    await pending[0];

    expect(delivered[0]?.event).toMatchObject({
      eventType: "span",
      level: "error",
      outcome: "failure",
      span: {
        errorType: "ValidationError",
        status: { code: "error" },
      },
    });
    expect(JSON.stringify(delivered[0]?.event)).not.toContain("private prompt text");
  });

  it("drains without a request context", async () => {
    const delivered: DrainContext[] = [];
    let resolveDrain!: () => void;
    const drainCompleted = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const sink = createEvlogObservabilitySink(
      drainThat((context) => {
        delivered.push(context);
        resolveDrain();
      }),
    );

    sink.onRpc?.(rpc());
    await drainCompleted;

    expect(delivered).toHaveLength(1);
  });
});
