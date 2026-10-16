import {
  DATA_KIND,
  dataFrame,
  PREVIEW_TUNNEL_VERSION,
  RUNNER_STREAM_BASE,
  type TunnelRunnerMessage,
  type TunnelThreadMessage,
  tunnelRunnerFrame,
  tunnelThreadFrame,
} from "@signalbox/runner-protocol/PreviewTunnel";
import { ThreadId } from "@t3tools/contracts";
import type { AgentBrowserStep } from "@t3tools/contracts/signalboxPreviews";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";

import { makeMemoryObjects } from "../../attachments/attachmentTesting.ts";
import * as Platform from "../../platform.ts";
import * as BrowserTrail from "./BrowserTrail.ts";
import { PreviewGateway } from "./PreviewGateway.ts";

const threadId = ThreadId.make("thread:4f1c");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A hibernatable socket as the gateway sees it: what it was sent, and its attachment. */
const makeSocket = () => {
  let attachment: unknown = null;
  const sent: Array<string | Uint8Array> = [];
  return {
    readyState: 1,
    sent,
    serializeAttachment: (value: unknown) => {
      attachment = structuredClone(value);
    },
    deserializeAttachment: () => structuredClone(attachment),
    send(data: string | Uint8Array) {
      sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
    /** The control frames sent so far. */
    messages: () =>
      sent
        .filter((data): data is string => typeof data === "string")
        .map((data): TunnelThreadMessage => tunnelThreadFrame.decode(data)),
  };
};
type FakeSocket = ReturnType<typeof makeSocket>;

const step = (n: number): AgentBrowserStep => ({
  stepId: `step-${n}`,
  tabId: "tab-1",
  action: "click",
  url: "https://example.com/",
  title: "Example",
  startedAt: "2026-10-16T10:00:00.000Z",
  endedAt: "2026-10-16T10:00:01.000Z",
});

interface Trail {
  readonly objects: ReturnType<typeof makeMemoryObjects>;
  readonly use: <A, E>(
    f: (trail: BrowserTrail.BrowserTrail["Service"]) => Effect.Effect<A, E>,
  ) => Promise<A>;
}

/** Runs `test` against a fresh trail in memory; the gateway's socket boundary is plain promises. */
const withTrail = (test: (trail: Trail) => Promise<void>) => {
  const objects = makeMemoryObjects();
  return Effect.gen(function* () {
    const service = yield* BrowserTrail.BrowserTrail;
    const run = yield* FiberSet.makeRuntimePromise();
    yield* Effect.promise(() => test({ objects, use: (f) => run(f(service)) }));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      BrowserTrail.layer({ objects, prefix: "pr-1/" }, () => threadId).pipe(
        Layer.provide(
          Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
        ),
      ),
    ),
  );
};

/** A thread object's gateway over fake sockets, keeping steps in `trail`. */
const makeGateway = (trail: Trail) => {
  const sockets = new Map<FakeSocket, ReadonlyArray<string>>();
  const ctx = {
    getWebSockets: (tag: string) =>
      [...sockets].filter(([, tags]) => tags.includes(tag)).map(([socket]) => socket),
    getTags: (socket: FakeSocket) => sockets.get(socket) ?? [],
  } as unknown as DurableObjectState;
  const errors: Array<string> = [];
  let viewers = 0;
  let holds = 0;
  const gateway = new PreviewGateway({
    ctx,
    settings: null,
    threadId: () => threadId,
    leaseToken: async (generation) => (generation >= 1 ? "lease" : null),
    canSee: async (userId) => userId !== "stranger",
    holdChanged: async () => {
      holds += 1;
    },
    storeStep: (found, recording) => trail.use((service) => service.store(found, recording)),
    browsed: () => trail.use((service) => service.browsed),
    logError: (message) => errors.push(message),
    viewerId: () => `viewer-${++viewers}`,
  });
  const tunnel = async (options: { readonly mirror?: boolean; readonly generation?: number }) => {
    const socket = makeSocket();
    sockets.set(socket, ["preview-tunnel"]);
    const ws = socket as unknown as WebSocket;
    const say = (message: TunnelRunnerMessage) =>
      gateway.onTunnelMessage(ws, tunnelRunnerFrame.encode(message));
    const data = (stream: number, text: string | Uint8Array) =>
      gateway.onTunnelMessage(
        ws,
        dataFrame(stream, DATA_KIND.body, typeof text === "string" ? encoder.encode(text) : text)
          .buffer as ArrayBuffer,
      );
    await say({
      type: "hello",
      version: PREVIEW_TUNNEL_VERSION,
      threadId,
      generation: options.generation ?? 1,
      token: "lease",
      ...(options.mirror === undefined ? {} : { mirror: options.mirror }),
    });
    return { socket, say, data, close: () => gateway.onTunnelClose(ws) };
  };
  return { gateway, trail, errors, tunnel, holds: () => holds };
};

/** Reads one newline-delimited line, however the stream chunked it. */
const lineReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let buffered = "";
  return {
    reader,
    next: async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end !== -1) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          return JSON.parse(line);
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("The watch stream ended.");
        buffered += decoder.decode(value, { stream: true });
      }
    },
  };
};

const opened = (socket: FakeSocket) =>
  socket.messages().filter((message) => message.type === "mirror.open");

describe("the agent's browser mirror", () => {
  it.effect("is offline until a mirroring machine says hello, then relays its lines", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel, holds } = makeGateway(trail);
      const watch = lineReader((await gateway.mirror.watch("user_1", null))!);
      expect(await watch.next()).toEqual({ _tag: "offline" });

      const machine = await tunnel({ mirror: true });
      const [open] = opened(machine.socket);
      expect(open).toEqual({ type: "mirror.open", stream: expect.any(Number), tabId: null });
      const stream = (open as { stream: number }).stream;
      expect(stream).toBeLessThan(RUNNER_STREAM_BASE);

      const state = {
        _tag: "state",
        viewerId: "the-runner's-name",
        tabs: [],
        tabId: "tab-1",
        control: "agent",
        resting: false,
        problem: null,
        notice: null,
      };
      const events = JSON.stringify({ _tag: "events", tabId: "tab-1", events: '[{"type":2}]' });
      // Lines span data frames; the thread names the viewer.
      await machine.data(stream, `${JSON.stringify(state)}\n${events.slice(0, 10)}`);
      await machine.data(stream, `${events.slice(10)}\n`);
      expect(await watch.next()).toEqual({ ...state, viewerId: "viewer-1" });
      expect(await watch.next()).toEqual(JSON.parse(events));

      // Watching never holds the machine.
      expect(gateway.held).toBe(false);
      expect(holds()).toBe(0);

      await machine.close();
      expect(await watch.next()).toEqual({ _tag: "offline" });
      const next = await tunnel({ mirror: true, generation: 2 });
      expect(opened(next.socket)).toHaveLength(1);
    }),
  );

  it.effect("ends a watcher that fell behind for good, without reopening it", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel } = makeGateway(trail);
      const machine = await tunnel({ mirror: true });
      // Nobody reads this one.
      const stalled = (await gateway.mirror.watch("user_1", null))!;
      const [open] = opened(machine.socket) as Array<{ stream: number }>;
      const events = `${JSON.stringify({ _tag: "events", tabId: "tab-1", events: `["${"x".repeat(1024 * 1024)}"]` })}\n`;
      for (let sent = 0; sent < 20; sent += 1) await machine.data(open!.stream, events);
      expect(machine.socket.messages().at(-1)).toEqual({ type: "cancel", stream: open!.stream });

      // What was queued still arrives, then the line that says why it ended.
      const watch = lineReader(stalled);
      let last: Record<string, unknown>;
      do last = await watch.next();
      while (last._tag === "events");
      expect(last).toEqual({ _tag: "behind" });
      expect((await watch.reader.read()).done).toBe(true);

      // A new machine doesn't pick it up again.
      const next = await tunnel({ mirror: true, generation: 2 });
      expect(opened(next.socket)).toEqual([]);
    }),
  );

  it.effect("waits offline while the machine doesn't mirror", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel } = makeGateway(trail);
      const watch = lineReader((await gateway.mirror.watch("user_1", "tab-1"))!);
      expect(await watch.next()).toEqual({ _tag: "offline" });
      const old = await tunnel({});
      expect(opened(old.socket)).toEqual([]);
      expect(gateway.mirror.input("user_1", "viewer-1", { _tag: "take" })._tag).toBe("unavailable");
    }),
  );

  it.effect("takes input only from the viewer's own user, and cancels when it stops watching", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel } = makeGateway(trail);
      const machine = await tunnel({ mirror: true });
      expect(await gateway.mirror.watch("stranger", null)).toBeNull();
      const watch = lineReader((await gateway.mirror.watch("user_1", "tab-1"))!);
      const [open] = opened(machine.socket) as Array<{ stream: number; tabId: string | null }>;
      expect(open!.tabId).toBe("tab-1");

      expect(gateway.mirror.input("user_2", "viewer-1", { _tag: "take" })._tag).toBe("unavailable");
      expect(gateway.mirror.input("user_1", "viewer-1", { _tag: "take" })).toEqual({
        _tag: "ok",
        value: null,
      });
      const inputs = machine.socket.messages().filter((message) => message.type === "mirror.input");
      expect(inputs).toEqual([
        { type: "mirror.input", stream: open!.stream, input: { _tag: "take" } },
      ]);

      await watch.reader.cancel();
      expect(machine.socket.messages().at(-1)).toEqual({ type: "cancel", stream: open!.stream });
      expect(gateway.mirror.input("user_1", "viewer-1", { _tag: "release" })._tag).toBe(
        "unavailable",
      );
    }),
  );

  it.effect("keeps each finished step in the trail, then tells watchers", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel } = makeGateway(trail);
      const machine = await tunnel({ mirror: true });
      const watch = lineReader((await gateway.mirror.watch("user_1", null))!);
      const recording = JSON.stringify([{ type: 2, data: { html: "<p>hi</p>".repeat(1000) } }]);
      const stream = RUNNER_STREAM_BASE + 1;

      await machine.say({ type: "trail.step", stream, step: step(1) });
      await machine.data(stream, recording.slice(0, 4000));
      await machine.data(stream, recording.slice(4000));
      await machine.say({ type: "end", stream });

      expect(await watch.next()).toEqual({ _tag: "step", step: step(1) });
      expect(await trail.use((service) => service.steps)).toEqual([step(1)]);
      expect(await trail.use((service) => service.browsed)).toBe(true);
      expect(await trail.use((service) => service.recording("step-1"))).toBe(recording);
      expect(await trail.use((service) => service.recording("step-2"))).toBeNull();
      // Stored gzipped, beside the thread's attachments under the preview prefix.
      const [key] = trail.objects.keys();
      expect(key).toMatch(/^pr-1\/browser-trail\/thread%3A4f1c\/[0-9a-f-]{36}\.json\.gz$/);
      expect((await trail.objects.head(key!))!.size).toBeLessThan(recording.length / 10);
    }),
  );

  it.effect("tells previews subscribers once the agent has browsed", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel } = makeGateway(trail);
      const machine = await tunnel({ mirror: true });
      const previews = lineReader((await gateway.subscribe("user_1"))!);
      expect(await previews.next()).toEqual({ ports: [] });

      const stream = RUNNER_STREAM_BASE + 1;
      await machine.say({ type: "trail.step", stream, step: step(1) });
      await machine.data(stream, "[]");
      await machine.say({ type: "end", stream });
      expect(await previews.next()).toEqual({ ports: [], browsed: true });

      // A later subscriber, on a fresh object over the same trail, hears it at once.
      const again = makeGateway(trail);
      const later = lineReader((await again.gateway.subscribe("user_1"))!);
      expect(await later.next()).toEqual({ ports: [], browsed: true });
    }),
  );

  it.effect("drops a recording past the step limit and tells the machine", () =>
    withTrail(async (trail) => {
      const { gateway, tunnel, errors } = makeGateway(trail);
      const machine = await tunnel({ mirror: true });
      const stream = RUNNER_STREAM_BASE + 7;
      await machine.say({ type: "trail.step", stream, step: step(1) });
      await machine.data(stream, new Uint8Array(BrowserTrail.MAX_STEP_BYTES + 1));
      await machine.say({ type: "end", stream });
      expect(machine.socket.messages().at(-1)).toEqual({ type: "cancel", stream });
      expect(errors).toEqual(["browser step recording dropped"]);
      expect(await trail.use((service) => service.steps)).toEqual([]);
      // A thread-numbered stream never carries a recording.
      await machine.say({ type: "trail.step", stream: 5, step: step(2) });
      await machine.data(5, "[]");
      await machine.say({ type: "end", stream: 5 });
      expect(await trail.use((service) => service.steps)).toEqual([]);
      expect(gateway.held).toBe(false);
    }),
  );
});

describe("the browser trail", () => {
  it.effect("keeps the newest steps and deletes older recordings", () =>
    withTrail(async ({ objects, use }) => {
      for (let n = 1; n <= BrowserTrail.MAX_STEPS + 2; n += 1) {
        await use((trail) => trail.store(step(n), [encoder.encode(`[${n}]`)]));
      }
      // A step kept already stays as it was.
      await use((trail) => trail.store(step(10), [encoder.encode("[0]")]));
      const steps = await use((trail) => trail.steps);
      expect(steps).toHaveLength(BrowserTrail.MAX_STEPS);
      expect(steps[0]!.stepId).toBe("step-3");
      expect(steps.at(-1)!.stepId).toBe(`step-${BrowserTrail.MAX_STEPS + 2}`);
      expect(objects.keys()).toHaveLength(BrowserTrail.MAX_STEPS);
      expect(await use((trail) => trail.recording("step-1"))).toBeNull();
      expect(await use((trail) => trail.recording("step-10"))).toBe("[10]");
    }),
  );

  it.effect("refuses a recording past the step limit", () =>
    withTrail(async ({ objects, use }) => {
      const failed = await use((trail) =>
        Effect.flip(trail.store(step(1), [new Uint8Array(BrowserTrail.MAX_STEP_BYTES + 1)])),
      );
      expect(failed._tag).toBe("BrowserTrailError");
      expect(objects.keys()).toEqual([]);
    }),
  );
});
