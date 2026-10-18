import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  PreviewAutomationConnectionId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return makeContext().page as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

function makeSession(frame?: ReturnType<typeof makeFrame>) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, listener: () => void) => events.on(name, listener)),
    emit: (name: string) => events.emit(name),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return { data: "ZnJhbWU=" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
      );
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

const contexts: ReturnType<typeof makeContext>[] = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let desktopRendersNext = false;
const desktopDetaches = new NodeEvents.EventEmitter();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
/** Desktop tabs a panel shows. */
const desktopVisibleTabs = new Set<string>();
const releasedDesktopTabs: Array<string> = [];
const desktopCloseGates = new Map<string, PromiseWithResolvers<void>>();
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
const threadShells = new Map<string, OrchestrationV2ThreadShell>();
const threadShellReadGates = new Map<
  string,
  {
    readonly started: PromiseWithResolvers<void>;
    readonly release: PromiseWithResolvers<void>;
    readonly interrupted?: PromiseWithResolvers<void>;
    readonly resumed?: PromiseWithResolvers<void>;
  }
>();
const threadShell = (
  threadId: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(threadId),
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    status: "idle",
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const forThread = (threadId: string, providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, threadId: ThreadId.make(threadId), providerSessionId },
});
const dependenciesAt = (home: string | { readonly prefix: string }, brokerLayer = Broker.layer) =>
  Layer.mergeAll(
    brokerLayer,
    Manager.layer,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => {
        const gate = threadShellReadGates.get(threadId);
        if (!gate) return Effect.succeed(threadShells.get(threadId) ?? null);
        threadShellReadGates.delete(threadId);
        return Effect.promise(() => {
          gate.started.resolve();
          return gate.release.promise;
        }).pipe(
          Effect.map(() => threadShells.get(threadId) ?? null),
          Effect.tap(() => Effect.sync(() => gate.resumed?.resolve())),
          Effect.onInterrupt(() => Effect.sync(() => gate.interrupted?.resolve())),
        );
      },
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(scope.environmentId),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    Layer.succeed(PreviewBrowser.PreviewBrowser, {
      executable: Effect.die("mock Chromium does not need an executable"),
      installed: Effect.die("mock Chromium does not need an executable"),
    }),
    Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
      // Only tabs a test marks render on the desktop; the rest stay headless.
      available: true,
      awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
      detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const onDetach = (key: { threadId: string; tabId: string }) =>
              Queue.offerUnsafe(queue, key);
            desktopDetaches.on("detach", onDetach);
            return onDetach;
          }),
          (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
        ),
      ),
      attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const onAttach = (key: { threadId: string; tabId: string }) =>
              Queue.offerUnsafe(queue, key);
            desktopDetaches.on("attach", onAttach);
            return onAttach;
          }),
          (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
        ),
      ),
      isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
      isVisible: (key) => desktopVisibleTabs.has(key.tabId),
      visibilityChanged: Stream.empty,
      endpoint: (key) =>
        Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
          Effect.sync(() => {
            releasedDesktopTabs.push(key.tabId);
            desktopCloseGates.get(key.tabId)?.resolve();
          }),
        ),
      pointer: () => Effect.void,
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
    Layer.provideMerge(NodeServices.layer),
  );
/** The service as one server process with its own home, or a fresh temporary one. */
const layerAt = (home: string | { readonly prefix: string }) =>
  ServerBrowser.layer.pipe(Layer.provideMerge(dependenciesAt(home)));
const layer = layerAt({ prefix: "t3-server-browser-" });
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
const stallViewer = (
  viewer: ServerBrowser.ServerBrowserViewer,
  item: ServerBrowser.ServerBrowserViewerOutput,
) => {
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  while (Queue.offerUnsafe(output, item));
};
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  contexts.length = 0;
  threadShells.clear();
  threadShellReadGates.clear();
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  desktopVisibleTabs.clear();
  desktopRendersNext = false;
  releasedDesktopTabs.length = 0;
  desktopCloseGates.clear();
  desktopConnections.length = 0;
});

it.live("cancels requests with a disconnected preview host before reconnecting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      type HostConnection = {
        readonly connectionId: ReturnType<typeof PreviewAutomationConnectionId.make>;
        readonly events: Queue.Queue<PreviewAutomationStreamEvent, Cause.Done>;
      };

      const connections = yield* Queue.unbounded<HostConnection>();
      const endedConnections = yield* Queue.unbounded<string>();
      const responses = yield* Queue.unbounded<PreviewAutomationResponse>();
      let connectionSequence = 0;
      const controlledBroker = Layer.mock(Broker.PreviewAutomationBroker)({
        connect: () =>
          Effect.gen(function* () {
            const connectionId = PreviewAutomationConnectionId.make(
              `server-host-${++connectionSequence}`,
            );
            const events = yield* Queue.unbounded<PreviewAutomationStreamEvent, Cause.Done>();
            yield* Queue.offer(connections, { connectionId, events });
            yield* Queue.offer(events, { type: "connected", connectionId });
            return Stream.fromQueue(events).pipe(
              Stream.ensuring(Queue.offer(endedConnections, connectionId).pipe(Effect.asVoid)),
            );
          }),
        focusHost: () => Effect.void,
        respond: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
        invoke: () => Effect.die("The controlled broker does not invoke preview clients."),
      });
      const serviceLayer = ServerBrowser.layer.pipe(
        Layer.provideMerge(
          dependenciesAt({ prefix: "t3-server-browser-reconnect-" }, controlledBroker),
        ),
      );
      const threadId = ThreadId.make("browser-reconnect-thread");
      const makeOpenRequest = (requestId: string): PreviewAutomationRequest => ({
        requestId,
        threadId,
        tabIdExplicit: false,
        agentSessionId: "browser-reconnect-agent",
        operation: "open",
        input: { reuseExistingTab: false, show: false },
        timeoutMs: 1_000,
      });
      const sendOpen = (connection: HostConnection, requestId: string) =>
        Queue.offer(connection.events, {
          type: "request",
          connectionId: connection.connectionId,
          request: makeOpenRequest(requestId),
        });

      yield* Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const firstConnection = yield* Queue.take(connections);
        yield* sendOpen(firstConnection, "initial-open");
        expect(yield* Queue.take(responses)).toMatchObject({ requestId: "initial-open", ok: true });

        threadShells.set(threadId, threadShell(threadId, { status: "running" }));
        const gate = {
          started: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
          interrupted: Promise.withResolvers<void>(),
          resumed: Promise.withResolvers<void>(),
        };
        threadShellReadGates.set(threadId, gate);
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.release.resolve()));

        yield* sendOpen(firstConnection, "blocked-open");
        yield* Effect.promise(() => gate.started.promise);
        const interruptedFiber = yield* Effect.promise(() => gate.interrupted.promise).pipe(
          Effect.as(true),
          Effect.timeoutOption(Duration.millis(1)),
          Effect.forkScoped,
        );
        yield* Queue.end(firstConnection.events);
        expect(yield* Queue.take(endedConnections)).toBe(firstConnection.connectionId);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(1));
        const interrupted = yield* Fiber.join(interruptedFiber);

        const reconnectFiber = yield* Queue.take(connections).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const secondConnection = yield* Fiber.join(reconnectFiber);
        yield* sendOpen(secondConnection, "reconnected-open");
        const reconnectedResponseFiber = yield* Queue.take(responses).pipe(
          Effect.timeoutOption(Duration.millis(50)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(50));
        const reconnectedResponse = yield* Fiber.join(reconnectedResponseFiber);

        gate.release.resolve();
        yield* Effect.yieldNow;
        const staleResponseFiber = yield* Queue.take(responses).pipe(
          Effect.timeoutOption(Duration.millis(50)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(50));
        const staleResponse = yield* Fiber.join(staleResponseFiber);
        const { sessions } = yield* manager.list({ threadId });

        expect(Option.isSome(interrupted)).toBe(true);
        expect(reconnectedResponse).toMatchObject({
          _tag: "Some",
          value: { requestId: "reconnected-open", ok: true },
        });
        expect(Option.isSome(staleResponse)).toBe(false);
        expect(sessions).toHaveLength(2);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), serviceLayer)));
    }),
  ),
);

it.live("readiness none responds immediately but takeover input waits for navigation commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const committed = Promise.withResolvers<void>();
      const events: string[] = [];
      contexts[0]!.page.goto.mockImplementationOnce(async () => {
        await committed.promise;
        events.push("navigation committed");
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      const response = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/next", readiness: "none" },
      });
      expect(response.available).toBe(true);
      expect(events).toEqual([]);
      yield* Queue.clear(viewer.output);
      const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller !== "you") {
        control = yield* Queue.take(viewer.output);
      }
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") events.push("human typed");
        return send(operation, input);
      });
      const typing = yield* viewer.input({ type: "text", text: "hello" }).pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      committed.resolve();
      yield* Fiber.join(takeover);
      yield* Fiber.join(typing);
      expect(events).toEqual(["navigation committed", "human typed"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://localhost:5173/next" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("release waits for viewer $method to commit before agent actions", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const events: string[] = [];
      contexts[0]!.page[method].mockImplementationOnce(async () => {
        started.resolve();
        await committed.promise;
        events.push("navigation committed");
      });
      const navigate = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      yield* Effect.promise(() => started.promise);
      const releasing = yield* viewer.input({ type: "releaseControl" }).pipe(Effect.forkScoped);
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller !== "agent") {
        control = yield* Queue.take(viewer.output);
      }
      const cdp = contexts[0]!.sessions[0]!;
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Runtime.evaluate") events.push("agent acted");
        return send(operation, input);
      });
      const resumed = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "resumed()" },
        })
        .pipe(Effect.forkScoped);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      expect(events).toEqual([]);
      committed.resolve();
      yield* Fiber.join(navigate);
      yield* Fiber.join(releasing);
      yield* Fiber.join(resumed);
      expect(events).toEqual(["navigation committed", "agent acted"]);
      const calls = contexts[0]!.page[method].mock.calls;
      expect(calls[0]?.at(-1)).toMatchObject({ waitUntil: "commit", timeout: 15_000 });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const page = contexts[0]!.page;
      page.setViewportSize.mockClear();
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      for (const message of [
        { type: "takeControl" },
        { type: "key", action: "down", key: "a", text: "a" },
        { type: "resize", width: 390, height: 844 },
        { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
      ])
        yield* viewer.input(message);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
      );
      expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
      );
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.input({ type: "takeControl" });
      yield* operator.input({ type: "text", text: "typed" });
      yield* operator.input({ type: "resize", width: 390, height: 844 });
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "typed",
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("applies any client's viewport, appearance, and zoom to a headless tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const page = contexts[0]!.page;
      const session = contexts[0]!.sessions[0]!;
      const target = { threadId: scope.thread.threadId, tabId };
      yield* manager.resize({ ...target, viewport: { _tag: "freeform", width: 390, height: 844 } });
      yield* manager.adjust({ ...target, colorScheme: "dark", zoomFactor: 1.25 });
      const reloaded = Promise.withResolvers<void>();
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.reload") reloaded.resolve();
        return send(method, input);
      });
      yield* manager.adjust({ ...target, hardReload: true });
      yield* Effect.promise(() => reloaded.promise);
      expect(session.send).toHaveBeenCalledWith("Page.reload", { ignoreCache: true });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      expect(page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
      expect(session.send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
        width: 312,
        height: 675,
        deviceScaleFactor: 2.5,
        mobile: false,
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("the owner can close a tab while an agent action waits on its dialog", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<Record<string, unknown>>();
      contexts[0]!.sessions[0]!.send.mockImplementationOnce(async () => {
        started.resolve();
        return finish.promise;
      });
      page.on("close", () => finish.resolve({ result: { value: "closed" } }));
      const running = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => finish.resolve({ result: { value: "cleanup" } })),
      );
      yield* Effect.promise(() => started.promise);
      page.emit("dialog", {
        type: () => "confirm",
        message: () => "Delete?",
        defaultValue: () => "",
        accept: vi.fn(),
        dismiss: vi.fn(),
      });
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "close",
          input: {},
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(page.close).not.toHaveBeenCalled();
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect(yield* Fiber.join(running)).toBe("closed");
      expect(page.close).toHaveBeenCalled();
      const manager = yield* Manager.PreviewManager;
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(0);
      const afterClose = yield* broker
        .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "late()" } })
        .pipe(Effect.flip);
      expect(afterClose._tag).toBe("PreviewAutomationTabNotFoundError");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a popup becomes the agent's own tab and keeps its opener page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const opener = contexts[0]!.page;
      const popup = makeContext();
      opener.emit("popup", popup.page);
      const manager = yield* Manager.PreviewManager;
      let sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      while (sessions.length < 2) {
        yield* Effect.sleep("5 millis");
        sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      }
      const popupTab = sessions.find((session) => session.tabId !== tabId)!;
      const opened = sessions.find((session) => session.tabId === tabId)!;
      expect(popupTab).toMatchObject({ automationOwner: opened.automationOwner, reveal: false });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId }),
          expect.objectContaining({ tabId: popupTab.tabId, openerTabId: tabId }),
        ]),
      );
      expect(opener.goto).not.toHaveBeenCalled();
      expect(opener.close).not.toHaveBeenCalled();
      yield* Effect.promise(() => popup.page.close());
      while ((yield* manager.list({ threadId: scope.thread.threadId })).sessions.length > 1) {
        yield* Effect.sleep("5 millis");
      }
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("reclaiming an isolated opener keeps its human-controlled popup context alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const threadId = "shared-popup-context-thread";
      const agentId = "shared-popup-context-agent";
      yield* Effect.yieldNow;
      const openerStatus = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const openerContext = contexts.at(-1)!;
      const popupContext = makeContext();
      popupContext.page.context = () => openerContext;
      const openerNewCDPSession = openerContext.newCDPSession;
      openerContext.newCDPSession = async (target) =>
        openerNewCDPSession(target === popupContext.page ? openerContext.page : target);
      const events = yield* manager.subscribeEvents;
      const popupOpened = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(events);
          if (event.type === "opened" && event.snapshot.threadId === threadId)
            return event.snapshot;
        }
      }).pipe(Effect.forkScoped);
      threadShells.set(threadId, threadShell(threadId, { settledOverride: "settled" }));

      openerContext.page.emit("popup", popupContext.page);
      const popupSnapshot = yield* Fiber.join(popupOpened);
      expect(popupSnapshot.tabId).not.toBe(openerStatus.tabId);
      const popupStatus = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        tabId: popupSnapshot.tabId,
        operation: "status",
        input: {},
      });
      expect(popupStatus.available).toBe(true);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const viewer = yield* browser.attachViewer({
            ...viewerInput(popupSnapshot.tabId, true),
            threadId: ThreadId.make(threadId),
          });
          yield* viewer.input({ type: "takeControl" });

          const groups = [
            { threadId: "shared-popup-active-a", agentId: "shared-popup-agent-a", count: 8 },
            { threadId: "shared-popup-active-b", agentId: "shared-popup-agent-b", count: 8 },
            { threadId: "shared-popup-active-c", agentId: "shared-popup-agent-c", count: 8 },
            { threadId: "shared-popup-active-d", agentId: "shared-popup-agent-d", count: 7 },
          ];
          for (const group of groups) {
            for (let index = 0; index < group.count; index += 1) {
              yield* broker.invoke({
                scope: forThread(group.threadId, group.agentId),
                operation: "open",
                input: { reuseExistingTab: false, show: false },
              });
            }
            threadShells.set(group.threadId, threadShell(group.threadId, { status: "running" }));
          }

          const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
          expect(sessions.map((session) => session.tabId)).toEqual([popupSnapshot.tabId]);
          expect(popupContext.page.isClosed()).toBe(false);
          expect(openerContext.close).not.toHaveBeenCalled();

          yield* viewer.input({ type: "releaseControl" });
        }),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["load", "failure", "close"] as const)(
  "keeps an adopted popup protected after the load timeout until $0",
  (terminal) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId: openerTabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const popupContext = makeContext();
        const timeout = new Error("popup load wait timed out");
        timeout.name = "TimeoutError";
        popupContext.page.waitForLoadState.mockRejectedValueOnce(timeout);
        const popupPrepared = Promise.withResolvers<void>();
        popupContext.page.setDefaultTimeout.mockImplementationOnce(() => {
          popupPrepared.resolve();
        });

        const events = yield* manager.subscribeEvents;
        const popupOpened = yield* Effect.gen(function* () {
          while (true) {
            const event = yield* PubSub.take(events);
            if (
              event.type === "opened" &&
              event.snapshot.threadId === scope.thread.threadId &&
              event.snapshot.tabId !== openerTabId
            )
              return event.snapshot;
          }
        }).pipe(Effect.forkScoped);
        contexts[0]!.page.emit("popup", popupContext.page);
        const snapshot = yield* Fiber.join(popupOpened);
        yield* Effect.promise(() => popupPrepared.promise);

        const pending = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId: snapshot.tabId,
          operation: "status",
          input: {},
        });
        expect(pending).toMatchObject({ available: true, loading: true });
        threadShells.set(
          scope.thread.threadId,
          threadShell(scope.thread.threadId, { settledOverride: "settled" }),
        );

        const cleanupWhileLoading = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(cleanupWhileLoading.serverTabCapacity?.lastCleanupBlocked.activeOperation).toBe(1);
        expect(
          (yield* manager.list({ threadId: scope.thread.threadId })).sessions.some(
            (session) => session.tabId === snapshot.tabId,
          ),
        ).toBe(true);
        expect(popupContext.page.isClosed()).toBe(false);

        if (terminal === "load") {
          popupContext.page.emit("load");
        } else if (terminal === "failure") {
          popupContext.page.emit("requestfailed", {
            isNavigationRequest: () => true,
            frame: () => popupContext.page,
            failure: () => ({ errorText: "net::ERR_FAILED" }),
            method: () => "GET",
            url: () => "https://example.test/popup",
          });
        } else {
          yield* Effect.promise(() => popupContext.page.close());
        }

        if (terminal === "close") {
          expect(popupContext.page.isClosed()).toBe(true);
        } else {
          const afterTerminal = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            tabId: snapshot.tabId,
            operation: "status",
            input: {},
          });
          expect(afterTerminal).toMatchObject({ available: true, loading: false });
        }

        const cleanupAfterTerminal = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(cleanupAfterTerminal.serverTabCapacity?.lastCleanupBlocked.activeOperation).toBe(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["load", "failure", "close"] as const)(
  "keeps a newer popup navigation protected when the initial request later fails, until $0",
  (terminal) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId: openerTabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const popupContext = makeContext();
        const timeout = new Error("popup load wait timed out");
        timeout.name = "TimeoutError";
        popupContext.page.waitForLoadState.mockRejectedValueOnce(timeout);
        const popupPrepared = Promise.withResolvers<void>();
        popupContext.page.setDefaultTimeout.mockImplementationOnce(() => {
          popupPrepared.resolve();
        });
        const events = yield* manager.subscribeEvents;
        const popupOpened = yield* Effect.gen(function* () {
          while (true) {
            const event = yield* PubSub.take(events);
            if (
              event.type === "opened" &&
              event.snapshot.threadId === scope.thread.threadId &&
              event.snapshot.tabId !== openerTabId
            )
              return event.snapshot;
          }
        }).pipe(Effect.forkScoped);
        contexts[0]!.page.emit("popup", popupContext.page);
        const snapshot = yield* Fiber.join(popupOpened);
        yield* Effect.promise(() => popupPrepared.promise);

        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => popupContext.page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        const initial = navigation("https://example.test/initial");
        const current = navigation("https://example.test/current");
        popupContext.page.emit("request", initial);
        popupContext.page.emit("request", current);
        popupContext.page.emit("requestfailed", initial);

        threadShells.set(
          scope.thread.threadId,
          threadShell(scope.thread.threadId, { settledOverride: "settled" }),
        );
        const beforeCleanup = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId: snapshot.tabId,
          operation: "status",
          input: {},
        });
        expect(beforeCleanup).toMatchObject({ available: true, loading: true });
        const whileCurrentNavigationLoads = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(whileCurrentNavigationLoads.serverTabCapacity?.lastCleanupBlocked).toMatchObject({
          activeOperation: 1,
        });
        expect(popupContext.page.isClosed()).toBe(false);

        if (terminal === "load") {
          popupContext.page.emit("load");
        } else if (terminal === "failure") {
          popupContext.page.emit("requestfailed", current);
        } else {
          yield* Effect.promise(() => popupContext.page.close());
        }

        const afterTerminal = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId: snapshot.tabId,
          operation: "status",
          input: {},
        });
        if (terminal === "close") {
          expect(afterTerminal.available).toBe(false);
        } else {
          expect(afterTerminal).toMatchObject({ available: true, loading: false });
        }

        const afterTerminalCleanup = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(afterTerminalCleanup.serverTabCapacity?.lastCleanupBlocked).toMatchObject({
          activeOperation: 0,
          loading: 0,
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("settles a popup that loads while tab setup is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId: openerTabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const popupContext = makeContext();
      const setup = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      const loadWait = Promise.withResolvers<void>();
      popupContext.page.setDefaultTimeout.mockImplementationOnce(() => {});
      popupContext.page.setViewportSize.mockImplementationOnce(async () => {
        setup.started.resolve();
        await setup.release.promise;
      });
      popupContext.page.waitForLoadState.mockImplementationOnce(() => loadWait.promise);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          setup.release.resolve();
          loadWait.resolve();
        }),
      );

      const events = yield* manager.subscribeEvents;
      const popupOpened = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(events);
          if (
            event.type === "opened" &&
            event.snapshot.threadId === scope.thread.threadId &&
            event.snapshot.tabId !== openerTabId
          )
            return event.snapshot;
        }
      }).pipe(Effect.forkScoped);

      contexts[0]!.page.emit("popup", popupContext.page);
      yield* Effect.promise(() => setup.started.promise);
      const navigation = (url: string) => ({
        url: () => url,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => popupContext.page,
      });
      popupContext.page.emit("request", navigation("https://example.test/first"));
      popupContext.page.emit("request", navigation("https://example.test/current"));
      popupContext.page.emit("load");
      setup.release.resolve();

      const snapshot = yield* Fiber.join(popupOpened);
      const loaded = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: snapshot.tabId,
        operation: "status",
        input: {},
      });
      expect(loaded).toMatchObject({ available: true, loading: false });

      threadShells.set(
        scope.thread.threadId,
        threadShell(scope.thread.threadId, { settledOverride: "settled" }),
      );
      yield* broker.invoke({
        scope: forThread("popup-setup-cleanup-trigger", "popup-setup-cleanup-agent"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      expect(popupContext.page.isClosed()).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("reclaims an already-loaded about:blank popup that never navigates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId: openerTabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const popupContext = makeContext();
      const popupPrepared = Promise.withResolvers<void>();
      popupContext.page.setDefaultTimeout.mockImplementationOnce(() => {
        popupPrepared.resolve();
      });
      const events = yield* manager.subscribeEvents;
      const popupOpened = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(events);
          if (
            event.type === "opened" &&
            event.snapshot.threadId === scope.thread.threadId &&
            event.snapshot.tabId !== openerTabId
          )
            return event.snapshot;
        }
      }).pipe(Effect.forkScoped);
      contexts[0]!.page.emit("popup", popupContext.page);
      const snapshot = yield* Fiber.join(popupOpened);
      yield* Effect.promise(() => popupPrepared.promise);

      const loaded = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: snapshot.tabId,
        operation: "status",
        input: {},
      });
      expect(loaded).toMatchObject({ available: true, loading: false });

      threadShells.set(
        scope.thread.threadId,
        threadShell(scope.thread.threadId, { settledOverride: "settled" }),
      );
      const afterCleanup = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      expect(afterCleanup.serverTabCapacity?.lastCleanupBlocked).toMatchObject({
        activeOperation: 0,
        loading: 0,
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("keeps an about:blank popup protected while a navigation request is pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId: openerTabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const popupContext = makeContext();
      const loadedBlank = Promise.withResolvers<void>();
      popupContext.page.waitForLoadState.mockImplementationOnce(() => loadedBlank.promise);
      const popupPrepared = Promise.withResolvers<void>();
      popupContext.page.setDefaultTimeout.mockImplementationOnce(() => {
        popupPrepared.resolve();
      });
      const events = yield* manager.subscribeEvents;
      const popupOpened = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(events);
          if (
            event.type === "opened" &&
            event.snapshot.threadId === scope.thread.threadId &&
            event.snapshot.tabId !== openerTabId
          )
            return event.snapshot;
        }
      }).pipe(Effect.forkScoped);
      contexts[0]!.page.emit("popup", popupContext.page);
      const snapshot = yield* Fiber.join(popupOpened);
      yield* Effect.promise(() => popupPrepared.promise);

      popupContext.page.emit("request", {
        url: () => "https://example.test/pending",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => popupContext.page,
      });
      // The blank document's load wait can resolve while this navigation is still pending.
      loadedBlank.resolve();
      threadShells.set(
        scope.thread.threadId,
        threadShell(scope.thread.threadId, { settledOverride: "settled" }),
      );

      const pending = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: snapshot.tabId,
        operation: "status",
        input: {},
      });
      expect(pending).toMatchObject({ available: true, loading: true });
      const cleanupWhilePending = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      expect(cleanupWhilePending.serverTabCapacity?.lastCleanupBlocked.activeOperation).toBe(1);
      expect(popupContext.page.isClosed()).toBe(false);

      popupContext.page.emit("load");
      const loaded = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: snapshot.tabId,
        operation: "status",
        input: {},
      });
      expect(loaded).toMatchObject({ available: true, loading: false });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("preview_open preserves host setup instructions when the browser cannot start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const setupCommand = "vp run browser:allow-sandbox";
      const setupError = new PreviewBrowserHost.PreviewBrowserSandboxError({ setupCommand });
      contextFailure = setupError;

      const error = yield* broker
        .invoke<void>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("PreviewAutomationExecutionError");
      expect(error.message).toContain(setupError.message);
      expect(error.message).toContain(setupCommand);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("reclaims settled agent tabs before adopting a popup at capacity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const groups = [
        { threadId: "popup-opener-thread", agentId: "popup-opener-agent" },
        { threadId: "popup-reclaim-thread", agentId: "popup-reclaim-agent" },
        { threadId: "popup-other-thread-a", agentId: "popup-other-agent-a" },
        { threadId: "popup-other-thread-b", agentId: "popup-other-agent-b" },
      ];
      let openerTabId: string | undefined;
      yield* Effect.yieldNow;
      for (const group of groups) {
        for (let index = 0; index < 8; index += 1) {
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope: forThread(group.threadId, group.agentId),
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
          if (group.threadId === "popup-opener-thread" && index === 0)
            openerTabId = opened.tabId ?? undefined;
        }
      }
      for (const group of groups)
        threadShells.set(
          group.threadId,
          threadShell(group.threadId, { settledOverride: "settled" }),
        );
      const opener = contexts[0]!.page;
      yield* browser.attachViewer({
        ...viewerInput(openerTabId!, false),
        threadId: ThreadId.make("popup-opener-thread"),
      });
      const popupContext = makeContext();
      const popupClosed = Promise.withResolvers<void>();
      popupContext.page.once("close", () => popupClosed.resolve());
      const popupPrepared = Promise.withResolvers<void>();
      popupContext.page.setDefaultTimeout.mockImplementationOnce(() => popupPrepared.resolve());
      const popupLoad = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      let initialLoadWaitStarted = false;
      popupContext.page.waitForLoadState.mockImplementationOnce(async () => {
        initialLoadWaitStarted = true;
        popupLoad.started.resolve();
        await popupLoad.release.promise;
      });

      const gate = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      threadShellReadGates.set("popup-reclaim-thread", gate);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          gate.release.resolve();
          popupLoad.release.resolve();
        }),
      );

      const events = yield* manager.subscribeEvents;
      const popupOpened = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(events);
          if (
            event.type === "opened" &&
            event.snapshot.threadId === "popup-opener-thread" &&
            event.snapshot.tabId !== openerTabId
          )
            return event;
        }
      }).pipe(Effect.forkScoped);

      opener.emit("popup", popupContext.page);
      const cleanupOrRejected = yield* Effect.promise(() =>
        Promise.race([
          gate.started.promise.then(() => "cleanup" as const),
          popupClosed.promise.then(() => "closed" as const),
        ]),
      );
      expect(cleanupOrRejected).toBe("cleanup");
      gate.release.resolve();

      const acceptedOrRejected = yield* Effect.promise(() =>
        Promise.race([
          popupPrepared.promise.then(() => "accepted" as const),
          popupClosed.promise.then(() => "closed" as const),
        ]),
      );
      expect(acceptedOrRejected).toBe("accepted");
      const openedPopup = yield* Fiber.join(popupOpened);
      expect(openedPopup).toMatchObject({
        type: "opened",
        snapshot: {
          threadId: "popup-opener-thread",
          automationOwner: expect.stringContaining("popup-opener-agent"),
        },
      });
      expect(initialLoadWaitStarted).toBe(true);
      expect(opener.close).not.toHaveBeenCalled();

      const activeGroups = [
        { threadId: "popup-loading-active-a", agentId: "popup-loading-agent-a", count: 8 },
        { threadId: "popup-loading-active-b", agentId: "popup-loading-agent-b", count: 8 },
        { threadId: "popup-loading-active-c", agentId: "popup-loading-agent-c", count: 8 },
        { threadId: "popup-loading-active-d", agentId: "popup-loading-agent-d", count: 6 },
      ];
      for (const group of activeGroups) {
        for (let index = 0; index < group.count; index += 1) {
          yield* broker.invoke({
            scope: forThread(group.threadId, group.agentId),
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
        }
        threadShells.set(group.threadId, threadShell(group.threadId, { status: "running" }));
      }
      const { sessions } = yield* manager.list({ threadId: ThreadId.make("popup-opener-thread") });
      expect(sessions.map((session) => session.tabId)).toContain(openedPopup.snapshot.tabId);
      expect(popupContext.page.isClosed()).toBe(false);
      popupLoad.release.resolve();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      // What Chromium reports when a navigation turns into a download.
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      let status = yield* PubSub.take(events);
      while (status.type !== "failed") status = yield* PubSub.take(events);
      expect(status).toMatchObject({ url: pdf, download: { fileName: "paper.pdf" } });
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file a blank tab opened is offered to download if the tab moves on while it saves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const navigation = {
        url: () => pdf,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", navigation);
      page.emit("requestfailed", navigation);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      page.emit("request", {
        url: () => "https://example.com/next",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      written.resolve();
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ _tag: "download", fileName: "paper.pdf" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a download from a superseded navigation leaves the newer navigation loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const navigation = {
        url: () => pdf,
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      page.emit("request", navigation);
      page.emit("requestfailed", navigation);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      page.emit("request", {
        url: () => "https://example.com/next",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
      });
      written.resolve();
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      while ((yield* status()).downloads?.length !== 1) yield* Effect.sleep("5 millis");
      expect((yield* status()).loading).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an aborted navigation that no download explains stops loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const navigation = {
        url: () => "https://example.com/cancelled",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        page.emit("request", navigation);
        page.emit("requestfailed", navigation);
        expect((yield* status()).loading).toBe(true);
        vi.advanceTimersByTime(5_000);
      } finally {
        vi.useRealTimers();
      }
      expect((yield* status()).loading).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a popup from a person's click is shown to that person, with its opener kept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const watcher = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const opener = contexts[0]!.page;
      const popup = makeContext();
      opener.emit("popup", popup.page);
      let shown = yield* Queue.take(viewer.output);
      while (shown._tag !== "popup") shown = yield* Queue.take(viewer.output);
      const sessions = (yield* manager.list({ threadId: scope.thread.threadId })).sessions;
      expect(sessions.map((session) => session.tabId)).toEqual(
        expect.arrayContaining([opened.tabId, shown.tabId]),
      );
      expect((yield* Queue.clear(watcher.output)).some((item) => item._tag === "popup")).toBe(
        false,
      );
      expect(opener.close).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("closing a tab while a viewer is still opening it does not leave its page behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      contextFailure = new Error("first launch failed");
      const snapshot = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      yield* Effect.sleep("10 millis");
      contextFailure = null;
      contextGate = Promise.withResolvers<void>();
      const attaching = yield* browser
        .attachViewer(viewerInput(snapshot.tabId, false))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.sleep("10 millis");
      yield* manager.close({ threadId: scope.thread.threadId, tabId: snapshot.tabId });
      yield* Effect.sleep("10 millis");
      contextGate.resolve();
      expect((yield* Fiber.join(attaching))._tag).toBe("ServerBrowserTabNotFoundError");
      expect(contexts).toHaveLength(1);
      expect(contexts[0]!.page.close).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("copy keys reach the viewer from a frame in its own process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const copy = () =>
        viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 }).pipe(
          Effect.andThen(Queue.clear(viewer.output)),
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      const frame = makeFrame();
      contexts[0]!.page.emit("framenavigated", frame);
      yield* Effect.promise(() => frame.recording.promise);
      const frameSession = contexts[0]!.sessions.at(-1)!;
      focusedFrame = frame;
      keyCopy = "framed";
      expect(yield* copy()).toEqual([{ _tag: "clipboard", text: "framed" }]);
      frame.copy = "left over";
      focusedFrame = null;
      keyCopy = "";
      expect(yield* copy()).toEqual([]);
      expect(frame.copy).toBe("");
      frame.detached = true;
      frame.copy = "gone";
      frameSession.emit("close");
      expect(yield* copy()).toEqual([]);
      expect(frame.copy).toBe("gone");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a page download is saved, offered to the controller, and listed for the agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      yield* Queue.clear(viewer.output);
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "report.csv",
        url: () => "blob:http://localhost:5173/1",
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Queue.take(saved);
      yield* fs.writeFileString(path, "a,b");
      written.resolve();
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
      const file = yield* browser.openDownload({
        threadId: scope.thread.threadId,
        tabId,
        downloadId: offered.id,
      });
      expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.downloads).toEqual([
        expect.objectContaining({ fileName: "report.csv", sizeBytes: 3 }),
      ]);
      expect(
        Option.isNone(
          yield* browser.openDownload({
            threadId: scope.thread.threadId,
            tabId,
            downloadId: "guess",
          }),
        ),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => "" }),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file picker replaces a stalled viewer backlog instead of being dropped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: () => accept.promise }),
        setFiles: async () => {},
      });
      yield* Queue.clear(viewer.output);
      stallViewer(viewer, { _tag: "viewport", width: 1, height: 1 });
      accept.resolve(".csv");
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      expect(yield* Queue.clear(viewer.output)).toEqual([
        expect.objectContaining({ _tag: "fileChooser", accept: ".csv" }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("control updates replace a stalled viewer backlog in the order they happen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* Queue.clear(viewer.output);
      const acked = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => acked.resolve()));
      stallViewer(viewer, {
        _tag: "frame",
        data: Buffer.alloc(0),
        ack: Effect.promise(() => acked.promise),
      });
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "releaseControl" });
      const controls = (yield* Queue.clear(viewer.output)).flatMap((item) =>
        item._tag === "control" ? [item.controller] : [],
      );
      expect(controls[0]).toBe("you");
      expect(controls.at(-1)).not.toBe("you");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent's tabs stop at the limit until an unwatched idle tab closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 8; count += 1) yield* open;
      expect(yield* Effect.flip(open)).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabLimit",
      });
      yield* broker.invoke({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const later = (yield* Clock.currentTimeMillis) + 31 * 60 * 1000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      const browser = yield* ServerBrowser.ServerBrowser;
      yield* browser.attachViewer(viewerInput(tabId, false));
      const reopened = yield* open;
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId).toSorted()).toEqual(
        [tabId, reopened.tabId].toSorted(),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "reclaims settled and archived agent tabs before rejecting an open at server capacity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        const groups = [
          { threadId: "settled-preview-thread", agentId: "settled-agent" },
          { threadId: "archived-preview-thread", agentId: "archived-agent" },
          { threadId: "active-preview-thread-a", agentId: "active-agent-a" },
          { threadId: "active-preview-thread-b", agentId: "active-agent-b" },
        ];
        for (const group of groups) {
          for (let index = 0; index < 8; index += 1) {
            yield* broker.invoke({
              scope: forThread(group.threadId, group.agentId),
              operation: "open",
              input: { reuseExistingTab: false, show: false },
            });
          }
        }

        threadShells.set(
          "settled-preview-thread",
          threadShell("settled-preview-thread", { settledOverride: "settled" }),
        );
        threadShells.set(
          "archived-preview-thread",
          threadShell("archived-preview-thread", {
            archivedAt: DateTime.makeUnsafe("2026-10-17T00:00:00.000Z"),
          }),
        );
        for (const group of groups.slice(2))
          threadShells.set(group.threadId, threadShell(group.threadId, { status: "running" }));

        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope: forThread("new-preview-thread", "new-agent"),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        expect(opened.available).toBe(true);
        expect(opened.serverTabCapacity).toEqual({
          used: 17,
          limit: 32,
          agentOwned: 17,
          humanControlled: 0,
          unclaimed: 0,
          pendingOpens: 0,
          lastCleanupClosed: 16,
          lastCleanupUnreadableThreads: 0,
          lastCleanupBlocked: {
            humanControlled: 0,
            visible: 0,
            activeOperation: 0,
            loading: 0,
            pendingInteraction: 0,
            recording: 0,
            lifecycleUnavailable: 0,
            activeThread: 16,
            idleWindow: 0,
          },
        });

        const manager = yield* Manager.PreviewManager;
        const settled = yield* manager.list({ threadId: ThreadId.make("settled-preview-thread") });
        const archived = yield* manager.list({
          threadId: ThreadId.make("archived-preview-thread"),
        });
        expect(settled.sessions).toHaveLength(0);
        expect(archived.sessions).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("interrupting the preview host cancels its pending open cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        interrupted: Promise.withResolvers<void>(),
        resumed: Promise.withResolvers<void>(),
      };
      const setupFinished = Promise.withResolvers<void>();
      const target = {
        threadId: "interrupted-cleanup-target",
        agentId: "interrupted-target-agent",
      };
      const child = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker.PreviewAutomationBroker;
          yield* Effect.yieldNow;
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope: forThread(target.threadId, target.agentId),
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
          expect(opened.available).toBe(true);
          threadShells.set(
            target.threadId,
            threadShell(target.threadId, { settledOverride: "settled" }),
          );
          threadShellReadGates.set(target.threadId, gate);
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.release.resolve()));

          yield* broker
            .invoke({
              scope: forThread("interrupted-open-request", "interrupted-open-agent"),
              operation: "open",
              input: { reuseExistingTab: false, show: false },
            })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => gate.started.promise);
          setupFinished.resolve();
          return yield* Effect.never;
        }).pipe(Effect.provide(layerAt({ prefix: "t3-server-browser-cancel-" }))),
      );
      const host = yield* Effect.forkScoped(child);
      yield* Effect.promise(() => setupFinished.promise);

      yield* Fiber.interrupt(host);
      gate.release.resolve();
      const cleanupOutcome = yield* Effect.promise(() =>
        Promise.race([
          gate.interrupted.promise.then(() => "interrupted" as const),
          gate.resumed.promise.then(() => "resumed" as const),
        ]),
      );
      expect(cleanupOutcome).toBe("interrupted");
    }),
  ),
);

it.live("rechecks a thread after another lifecycle read before reclaiming its tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      const groups = [
        { threadId: "slow-cleanup-thread", agentId: "slow-cleanup-agent", count: 1 },
        { threadId: "changing-cleanup-thread", agentId: "changing-cleanup-agent", count: 1 },
        { threadId: "active-cleanup-thread-a", agentId: "active-cleanup-agent-a", count: 8 },
        { threadId: "active-cleanup-thread-b", agentId: "active-cleanup-agent-b", count: 8 },
        { threadId: "active-cleanup-thread-c", agentId: "active-cleanup-agent-c", count: 8 },
        { threadId: "active-cleanup-thread-d", agentId: "active-cleanup-agent-d", count: 6 },
      ];
      yield* Effect.yieldNow;
      for (const group of groups) {
        for (let index = 0; index < group.count; index += 1) {
          yield* broker.invoke({
            scope: forThread(group.threadId, group.agentId),
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
        }
      }

      const changingThreadId = "changing-cleanup-thread";
      const { sessions: initialSessions } = yield* manager.list({
        threadId: ThreadId.make(changingThreadId),
      });
      expect(initialSessions).toHaveLength(1);
      threadShells.set(
        changingThreadId,
        threadShell(changingThreadId, { settledOverride: "settled" }),
      );
      for (const group of groups.slice(2))
        threadShells.set(group.threadId, threadShell(group.threadId, { status: "running" }));

      const gate = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      threadShellReadGates.set("slow-cleanup-thread", gate);
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.release.resolve()));

      const trigger = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope: forThread("capacity-trigger-thread", "capacity-trigger-agent"),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => gate.started.promise);
      threadShells.set(changingThreadId, threadShell(changingThreadId, { status: "running" }));
      gate.release.resolve();

      const failure = yield* Fiber.join(trigger).pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "tabLimit" });
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(changingThreadId) });
      expect(sessions).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("preserves tabs while their thread is active, even after the tab idle window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const threadId = "active-preview-thread";
      const agentId = "active-preview-agent";
      yield* Effect.yieldNow;
      for (let index = 0; index < 8; index += 1) {
        yield* broker.invoke({
          scope: forThread(threadId, agentId),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
      }
      threadShells.set(threadId, threadShell(threadId, { status: "running" }));
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_893_456_000_000);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));

      const failure = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope: forThread(threadId, agentId),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "tabLimit" });

      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
      expect(sessions).toHaveLength(8);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("preserves a human-controlled agent tab during idle cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const threadId = "human-preview-thread";
      const agentId = "human-preview-agent";
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const viewer = yield* browser.attachViewer({
        ...viewerInput(opened.tabId!, true),
        threadId: ThreadId.make(threadId),
      });
      yield* viewer.input({ type: "takeControl" });
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_893_456_000_000);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));

      yield* broker.invoke({
        scope: forThread("human-cleanup-trigger", "trigger-agent"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        tabId: opened.tabId!,
        operation: "status",
        input: {},
      });
      expect(status.available).toBe(true);
      expect(status.control?.owner).toBe("human");
      yield* viewer.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("skips a tab whose control generation changed during lifecycle cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const target = { threadId: "generation-cleanup-target", agentId: "generation-target-agent" };
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(target.threadId, target.agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const activeGroups = [
        { threadId: "generation-active-a", agentId: "generation-agent-a", count: 8 },
        { threadId: "generation-active-b", agentId: "generation-agent-b", count: 8 },
        { threadId: "generation-active-c", agentId: "generation-agent-c", count: 8 },
        { threadId: "generation-active-d", agentId: "generation-agent-d", count: 7 },
      ];
      for (const group of activeGroups) {
        for (let index = 0; index < group.count; index += 1) {
          yield* broker.invoke({
            scope: forThread(group.threadId, group.agentId),
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          });
        }
        threadShells.set(group.threadId, threadShell(group.threadId, { status: "running" }));
      }
      threadShells.set(
        target.threadId,
        threadShell(target.threadId, { settledOverride: "settled" }),
      );
      const gate = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      threadShellReadGates.set(target.threadId, gate);
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.release.resolve()));

      const trigger = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope: forThread("generation-cleanup-trigger", "generation-trigger-agent"),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => gate.started.promise);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const viewer = yield* browser.attachViewer({
            ...viewerInput(opened.tabId!, true),
            threadId: ThreadId.make(target.threadId),
          });
          yield* viewer.input({ type: "takeControl" });
          yield* viewer.input({ type: "releaseControl" });
          const controls = (yield* Queue.clear(viewer.output)).filter(
            (item) => item._tag === "control",
          );
          expect(controls.some((item) => item._tag === "control" && item.generation > 0)).toBe(
            true,
          );
        }),
      );
      gate.release.resolve();

      const failure = yield* Fiber.join(trigger).pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "tabLimit" });
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(target.threadId) });
      expect(sessions.map((session) => session.tabId)).toContain(opened.tabId);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("does not idle-close a tab while its automation request is still running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const threadId = "inflight-preview-thread";
      const agentId = "inflight-preview-agent";
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const page = contexts[0]!.page;
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const originalGoto = page.goto.getMockImplementation()!;
      page.goto.mockImplementationOnce(async (url) => {
        started.resolve();
        await resume.promise;
        await originalGoto(url);
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_893_456_000_000);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clock.mockRestore();
          resume.resolve();
        }),
      );
      const navigation = yield* broker
        .invoke({
          scope: forThread(threadId, agentId),
          tabId: opened.tabId!,
          operation: "navigate",
          input: { url: "http://example.com" },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);

      yield* broker.invoke({
        scope: forThread("inflight-cleanup-trigger", "trigger-agent"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const manager = yield* Manager.PreviewManager;
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
      expect(sessions.map((session) => session.tabId)).toContain(opened.tabId);

      resume.resolve();
      yield* Fiber.join(navigation);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("protects the selected reused tab while cleaning its settled sibling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const threadId = "reused-open-preview-thread";
      const agentId = "reused-open-preview-agent";
      yield* Effect.yieldNow;
      const selected = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const sibling = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      threadShells.set(threadId, threadShell(threadId, { settledOverride: "settled" }));

      const page = contexts[0]!.page;
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const originalGoto = page.goto.getMockImplementation()!;
      page.goto.mockImplementationOnce(async (url) => {
        started.resolve();
        await resume.promise;
        await originalGoto(url);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          resume.resolve();
        }),
      );

      const reuse = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope: forThread(threadId, agentId),
          tabId: selected.tabId!,
          operation: "open",
          input: { reuseExistingTab: true, url: "http://example.com/reused", show: false },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);

      yield* broker.invoke({
        scope: forThread("reused-open-cleanup-trigger", "reused-open-trigger-agent"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        tabId: selected.tabId!,
        operation: "status",
        input: {},
      });
      expect(status.available).toBe(true);
      expect(status.tabs?.map((tab) => tab.tabId)).toContain(selected.tabId);
      expect(status.tabs?.map((tab) => tab.tabId)).not.toContain(sibling.tabId);

      resume.resolve();
      expect((yield* Fiber.join(reuse)).available).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("does not close a same-key hidden replacement when cleanup finishes an older read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const browser = yield* ServerBrowser.ServerBrowser;
      const threadId = "replacement-preview-thread";
      const agentId = "replacement-preview-agent";
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const original = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      expect(desktopConnections).toHaveLength(1);
      threadShells.set(threadId, threadShell(threadId, { settledOverride: "settled" }));
      const gate = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      threadShellReadGates.set(threadId, gate);
      const detached = Promise.withResolvers<void>();
      desktopCloseGates.set(original.tabId!, detached);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          gate.release.resolve();
          detached.resolve();
        }),
      );

      const trigger = yield* broker
        .invoke({
          scope: forThread("replacement-cleanup-trigger", "trigger-agent"),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => gate.started.promise);

      desktopDetaches.emit("detach", {
        threadId: ThreadId.make(threadId),
        tabId: original.tabId!,
      });
      yield* Effect.promise(() => detached.promise);
      yield* Effect.scoped(
        browser
          .attachViewer({
            ...viewerInput(original.tabId!, false),
            threadId: ThreadId.make(threadId),
          })
          .pipe(Effect.asVoid),
      );
      expect(desktopConnections).toHaveLength(2);
      expect(desktopConnections[1]!.context.page.isClosed()).toBe(false);

      gate.release.resolve();
      yield* Fiber.join(trigger);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope: forThread(threadId, agentId),
        tabId: original.tabId!,
        operation: "status",
        input: {},
      });
      expect(status.available).toBe(true);
      expect(status.tabs?.map((tab) => tab.tabId)).toContain(original.tabId);
      expect(desktopConnections[1]!.context.page.isClosed()).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent answers the page's file picker or sets files on a file input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const upload = (input: Record<string, unknown>) =>
        broker.invoke<void>({ scope, tabId, operation: "upload", input });
      expect(yield* Effect.flip(upload({ paths: ["/tmp/a.csv"] }))).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
      });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      const status = broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      let opened = yield* status;
      while (!opened.fileChooser) {
        yield* Effect.sleep("5 millis");
        opened = yield* status;
      }
      expect(opened.fileChooser).toEqual({ multiple: false, accept: ".csv" });
      yield* Effect.flip(upload({ paths: ["/tmp/a.csv", "/tmp/b.csv"] }));
      yield* upload({ paths: ["/tmp/a.csv"] });
      expect(setFiles).toHaveBeenCalledExactlyOnceWith(["/tmp/a.csv"], expect.anything());
      expect((yield* status).fileChooser).toBeNull();

      const setInputFiles = vi.fn(async () => {});
      page.locator.mockReturnValue({ setInputFiles } as never);
      yield* upload({ paths: ["/tmp/b.csv"], locator: "input[type=file]" });
      expect(page.locator).toHaveBeenLastCalledWith("input[type=file]");
      expect(setInputFiles).toHaveBeenCalledWith(["/tmp/b.csv"], expect.anything());
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("viewers see the agent's pointer move to its target and click there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const click = vi.fn(async () => {});
      page.locator.mockReturnValue({
        scrollIntoViewIfNeeded: async () => {},
        boundingBox: async () => ({ x: 100, y: 40, width: 80, height: 20 }),
        click,
      } as never);
      yield* broker.invoke({ scope, tabId, operation: "click", input: { locator: "#go" } });
      const pointers = (yield* Queue.clear(viewer.output)).filter(
        (item) => item._tag === "pointer",
      );
      expect(pointers).toEqual([
        expect.objectContaining({ phase: "move", x: 140, y: 50 }),
        expect.objectContaining({ phase: "click", x: 140, y: 50 }),
      ]);
      expect(click).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("drives the desktop's own page for a tab the desktop renders", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      expect(desktopConnections.map((connection) => connection.endpoint)).toEqual([
        `ws://desktop/${opened.tabId}`,
      ]);
      expect(contexts).toEqual([]);
      const page = desktopConnections[0]!.context.page;
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "resize", width: 390, height: 844 });
      expect(page.setViewportSize).not.toHaveBeenCalled();
      yield* viewer.input({ type: "releaseControl" });
      const evaluated = yield* broker.invoke({
        scope: asSession("agent-desktop"),
        operation: "status",
        input: {},
        tabId: PreviewTabId.make(opened.tabId),
      });
      expect(evaluated).toMatchObject({ tabId: opened.tabId });
      yield* manager.close({ threadId: scope.thread.threadId, tabId: opened.tabId });
      while (releasedDesktopTabs.length === 0) yield* Effect.yieldNow;
      expect(releasedDesktopTabs).toEqual([opened.tabId]);
      expect(page.close).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop tab is visible while a desktop panel shows it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const status = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
        tabId: PreviewTabId.make(opened.tabId),
      });
      // The desktop draws the page itself, so no viewer ever streams it.
      expect(yield* status).toMatchObject({ visible: false });
      desktopVisibleTabs.add(opened.tabId);
      const shown = yield* status;
      expect(shown).toMatchObject({ visible: true });
      expect(shown.tabs).toEqual([expect.objectContaining({ tabId: opened.tabId, visible: true })]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a desktop page the desktop takes back reconnects instead of closing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, false));
      // The server's listener subscribes in its own fiber; detach once it is there.
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      let end = yield* Queue.take(viewer.output);
      while (end._tag !== "reconnect" && end._tag !== "gone")
        end = yield* Queue.take(viewer.output);
      expect(end._tag).toBe("reconnect");
      expect(releasedDesktopTabs).toEqual([opened.tabId]);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toContain(opened.tabId);
      yield* browser.attachViewer(viewerInput(opened.tabId, false));
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a headless tab moves to the desktop's page once the desktop renders it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The desktop had no webview for the tab in time, so it launched headless.
      const { browser, broker, tabId } = yield* ready;
      const headless = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      // Then the desktop showed the thread and offered its own page for the tab.
      while (desktopDetaches.listenerCount("attach") === 0) yield* Effect.yieldNow;
      desktopTabs.add(tabId);
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId });
      const end = yield* Queue.take(viewer.output).pipe(
        Effect.repeat({ until: (item) => item._tag === "reconnect" || item._tag === "gone" }),
        Effect.timeout("2 seconds"),
      );
      expect(end._tag).toBe("reconnect");
      // The agent's next call reaches the tab through the desktop's page.
      expect(headless.close).toHaveBeenCalled();
      // The agent keeps its tab and now drives the page the person sees.
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/after" },
      });
      expect(desktopConnections[0]!.context.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/after",
        expect.anything(),
      );
      expect(headless.goto).not.toHaveBeenCalled();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.control).toMatchObject({ owner: "agent", ownedByCaller: true });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId,
        control: { owner: "human", ownedByCaller: false },
      });
      expect(status.tabs).toEqual([
        expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
      ]);
      const evaluated = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
        .pipe(Effect.flip);
      expect(evaluated).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const refused = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* viewer.input({ type: "releaseControl" });
      const released = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/agent" },
      });
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/agent",
        expect.anything(),
      );
      yield* viewer.input({ type: "takeControl" });
      const retaken = yield* broker
        .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
        .pipe(Effect.flip);
      expect(retaken).toMatchObject({ reason: "humanControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        yield* browser.reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an agent tab keeps throwaway storage when no client reported profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      expect(contextRequests).toEqual([{ profileId: "default", isolated: true }]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent tab keeps the profile clients last reported after a server restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-browser-restart-" });
    yield* Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      yield* browser.reportProfiles({
        profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
        defaultProfileId: "profile-work",
      });
    }).pipe(Effect.scoped, Effect.provide(layerAt(home)));
    // The restarted server opens an agent tab before any client reports again.
    yield* Effect.gen(function* () {
      yield* ready;
      expect(contextRequests).toEqual([{ profileId: "profile-work", isolated: false }]);
    }).pipe(Effect.scoped, Effect.provide(layerAt(home)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a desktop page that comes back reconnects without waiting for a viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      desktopRendersNext = true;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      while (desktopConnections.length === 0) yield* Effect.yieldNow;
      while (desktopDetaches.listenerCount("detach") === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      while (releasedDesktopTabs.length === 0) yield* Effect.yieldNow;
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: opened.tabId });
      while (desktopConnections.length < 2) yield* Effect.yieldNow;
      expect(desktopConnections).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);
