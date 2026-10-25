import { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { CodexHarnessProcess } from "../../CodexHarnessProcess.ts";
import { hostBindingFixture } from "./hostBindingFixture.ts";

const encodeFrame = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMcpConfiguration = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: Schema.optional(Schema.String),
    config: Schema.Struct({
      mcp_servers: Schema.Struct({ executor: Schema.Struct({ url: Schema.String }) }),
    }),
  }),
);

const routeEpoch = (url: string | undefined) =>
  url === undefined ? undefined : Number(new URL(url).pathname.split("/").at(-2));

const completeTurn = (
  output: ReadableStreamDefaultController<Uint8Array>,
  turnId = "preinitialized-turn",
) =>
  output.enqueue(
    new TextEncoder().encode(
      encodeFrame({
        method: "turn/completed",
        params: {
          threadId: "preinitialized-native-thread",
          turn: { id: turnId, status: "completed", items: [], error: null },
        },
      }) + "\n",
    ),
  );

export const runLiveGrantSecondTurn = (
  launchPeer: (process: CodexHarnessProcess, onLaunch: () => void) => void,
  injectFirstInitializeFailure = false,
) =>
  Effect.gen(function* () {
    const hostFixture = yield* hostBindingFixture();
    const { f, instance, peer } = hostFixture;
    let processLaunches = 0;
    launchPeer(peer.process, () => processLaunches++);
    const session = yield* instance.open();
    const mcp = hostFixture.mcp;
    const access = f.access("same-live-grant");
    const terminals = yield* Queue.unbounded<void>();
    const terminalConsumer = yield* session.events.pipe(
      Stream.filter((item) => item.kind === "provider" && item.event.type === "turn.terminal"),
      Stream.runForEach(() => Queue.offer(terminals, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );

    yield* session.turn({ turn: instance.adapter.turn, access });
    const threadStart = peer.requests.find((request) => request.method === "thread/start");
    if (threadStart?.params === undefined)
      return yield* Effect.die("Codex thread/start omitted its MCP configuration");
    const firstUrl = decodeMcpConfiguration(threadStart.params).config.mcp_servers.executor.url;

    let handshakeRejected = false;
    if (injectFirstInitializeFailure) {
      f.setForward(async ({ request }) => {
        if (request.method === "POST")
          throw new Error("synthetic MCP initialize transport failure: recv failed errno 29");
        return new Response("executor");
      });
      const initialize = yield* Effect.tryPromise(() =>
        mcp.fetch(
          new Request(firstUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeFrame({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2025-06-18", capabilities: {} },
            }),
          }),
        ),
      ).pipe(Effect.exit);
      handshakeRejected = Exit.isFailure(initialize);
    }

    const firstRoute = yield* Effect.tryPromise(() => mcp.fetch(new Request(firstUrl)));
    const firstRouteBody = yield* Effect.promise(() => firstRoute.text());
    const output = yield* Effect.promise(() => peer.output);
    completeTurn(output);
    yield* Queue.take(terminals);
    const checkpoint = yield* session.export();
    const firstNativeThreadId = checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId;
    const firstRetiredRoute = yield* Effect.tryPromise(() => mcp.fetch(new Request(firstUrl))).pipe(
      Effect.exit,
    );

    const base = instance.adapter.turn;
    const secondTurn = {
      ...base,
      runId: RunId.make("codex-host-second-run"),
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      attemptId: RunAttemptId.make("codex-host-second-attempt"),
      providerThread: checkpoint.snapshot.providerThread,
      message: {
        ...base.message,
        messageId: MessageId.make("codex-host-second-message"),
        text: "second ordinary turn",
      },
    };
    const secondStart = yield* session.turn({ turn: secondTurn, access }).pipe(Effect.exit);
    const secondTurnStarted = Exit.isSuccess(secondStart);
    let secondUrl: string | undefined;
    let resumedNativeThreadId: string | undefined;
    let secondRouteBody: string | undefined;
    let secondRouteRetired: boolean | undefined;
    let currentRouteGrantMatches = false;

    if (secondTurnStarted) {
      const resume = peer.requests.find((request) => request.method === "thread/resume");
      if (resume?.params !== undefined) {
        const configuration = decodeMcpConfiguration(resume.params);
        const url = configuration.config.mcp_servers.executor.url;
        secondUrl = url;
        resumedNativeThreadId = configuration.threadId;
        const currentRoute = yield* Effect.tryPromise(() => mcp.fetch(new Request(url)));
        secondRouteBody = yield* Effect.promise(() => currentRoute.text());
        currentRouteGrantMatches = f.forwards.at(-1)?.grant === access.grant;
        completeTurn(output);
        yield* Queue.take(terminals);
        const retiredRoute = yield* Effect.tryPromise(() => mcp.fetch(new Request(url))).pipe(
          Effect.exit,
        );
        secondRouteRetired = Exit.isFailure(retiredRoute);
      }
      yield* session.dispose;
    }

    yield* Fiber.interrupt(terminalConsumer);
    return {
      handshakeRejected,
      firstRouteBody,
      secondTurnStarted,
      processLaunches,
      nativeMethods: peer.sent,
      firstNativeThreadId,
      resumedNativeThreadId,
      firstRouteEpoch: routeEpoch(firstUrl),
      secondRouteEpoch: routeEpoch(secondUrl),
      firstRouteRetired: Exit.isFailure(firstRetiredRoute),
      secondRouteBody,
      secondRouteRetired,
      accessStayedLive: !access.signal.aborted,
      currentRouteGrantMatches,
    };
  });
