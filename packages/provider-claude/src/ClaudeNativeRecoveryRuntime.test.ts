import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { prepareClaudeNativeAdmission } from "@signalbox/provider-claude/ClaudeAdapter";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { fixture, run } from "./tests/ClaudeNativeRecoveryTestkit.ts";

const promptUuid = "00000000-0000-4000-8000-000000000001";
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "",
  iterations: [],
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  speed: "standard",
} satisfies Extract<SDKResultMessage, { subtype: "success" }>["usage"];
const firstFrame: SDKMessage = {
  type: "stream_event",
  uuid: promptUuid,
  session_id: "native-session",
  parent_tool_use_id: null,
  user_message_uuid: promptUuid,
  resume_reason: "interrupted_turn",
  event: {
    type: "message_start",
    message: {
      id: "resumed-native-message",
      type: "message",
      role: "assistant",
      model: "model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      usage,
    },
  },
};
const resultFrame = (num_turns: number): SDKResultMessage => ({
  type: "result",
  subtype: "success",
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns,
  result: "done",
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage,
  modelUsage: {},
  permission_denials: [],
  uuid: promptUuid,
  session_id: "native-session",
  user_message_uuid: promptUuid,
  terminal_reason: "completed",
});

const drainEvents = (stream: ProviderAdapterV2SessionRuntime["events"]) =>
  Effect.gen(function* () {
    const events: ProviderAdapterV2Event[] = [];
    const reader = yield* stream.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Fiber.interrupt(reader);
    return events;
  });

describe("Claude explicit native recovery protocol", () => {
  it.effect("reserves a prompt UUID without opening a query", () =>
    Effect.gen(function* () {
      let allocated = 0;
      const admission = yield* prepareClaudeNativeAdmission(
        {
          logicalRunId: "run",
          nativeIncarnationId: "boot",
          nativeSessionId: "session",
          nativeFiles: { filesystemId: "files", home: "/claude" },
          providerRelease: "2.1.302",
          inputId: "input",
        },
        {
          randomUUIDv4: () =>
            Effect.sync(() => {
              allocated += 1;
              return promptUuid;
            }),
        },
      );
      expect(allocated).toBe(1);
      expect(admission).toMatchObject({ nativeInputId: promptUuid, inputDurability: "reserved" });
    }),
  );
  it.effect(
    "opens official interrupted-turn recovery on the same session without a prompt offer or empty-buffer completion",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.runtime.resumeThread({ providerThread: f.turn.providerThread });
          expect(f.opened).toEqual([]);
          yield* f.runtime.startTurn(f.turn);
          expect(f.order).toEqual(["reserve", "open"]);
          expect(f.opened[0]?.options).toMatchObject({
            resume: "native-session",
            env: { CUSTOM: "preserved", CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" },
          });
          expect(f.opened[0]?.options).not.toHaveProperty("resumeSessionAt");
          expect(f.offers).toEqual([]);
          expect(f.receipts.map((r) => r.status)).toEqual(["reserved"]);
          const events = yield* drainEvents(f.runtime.events);
          expect(events.some((event) => event.type === "turn.terminal")).toBe(false);
          expect(
            events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
            ),
          ).toBe(false);
        }),
      ),
  );
  it.effect("routes the first native frame to the existing logical run before consumption", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ initial: [firstFrame] });
        yield* f.runtime.startTurn(f.turn);
        yield* Deferred.await(f.continued);
        expect(f.receipts.find((r) => r.status === "continued")).toMatchObject({
          admission: { logicalRunId: f.turn.runId, nativeIncarnationId: "boot-2" },
          nativeMessageId: "resumed-native-message",
        });
        yield* f.send(resultFrame(1));
        const terminal = yield* Stream.runHead(
          f.runtime.events.pipe(Stream.filter((event) => event.type === "turn.terminal")),
        );
        expect(terminal).toMatchObject({
          value: { status: "completed", runOrdinal: f.turn.runOrdinal },
        });
        expect(f.offers).toEqual([]);
        expect(f.receipts.some((r) => r.status === "native-admitted")).toBe(false);
      }),
    ),
  );
  it.effect(
    "reports suppressed rescue as indeterminate and never completes from a zero-turn acknowledgement",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({ initial: [resultFrame(0)] });
          yield* f.runtime.startTurn(f.turn);
          yield* Deferred.await(f.uncertain);
          const terminal = yield* Stream.runHead(
            f.runtime.events.pipe(Stream.filter((event) => event.type === "turn.terminal")),
          );
          expect(terminal).toMatchObject({ value: { status: "failed" } });
          expect(f.receipts.some((r) => r.status === "completed")).toBe(false);
        }),
      ),
  );
  it.effect("keeps a fresh prompt reserved while the exact UUID waits in the local queue", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ fresh: true });
        yield* f.runtime.startTurn(f.turn);
        expect(f.order).toEqual(["reserve", "open", "offer"]);
        expect(f.offers[0]?.uuid).toBe(promptUuid);
        expect(f.offers[0]?.message.content).toBe(f.turn.message.text);
        expect(f.receipts.map((receipt) => receipt.status)).toEqual(["reserved", "reserved"]);
        expect(f.receipts.at(-1)?.operation).toBe("prompt/offer");
        expect((yield* Effect.exit(f.runtime.startTurn(f.turn)))._tag).toBe("Failure");
        expect(f.offers).toHaveLength(1);
      }),
    ),
  );
  it.effect("rejects output from another native prompt instead of completing this run", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          initial: [{ ...resultFrame(1), user_message_uuid: "foreign-prompt" }],
        });
        yield* f.runtime.startTurn(f.turn);
        yield* Deferred.await(f.uncertain);
        const terminal = yield* Stream.runHead(
          f.runtime.events.pipe(Stream.filter((event) => event.type === "turn.terminal")),
        );
        expect(terminal).toMatchObject({ value: { status: "failed" } });
        expect(f.receipts.some((r) => r.status === "completed")).toBe(false);
      }),
    ),
  );
  it.effect("does not open native recovery when reservation persistence fails", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ denyReservation: true });
        expect((yield* Effect.exit(f.runtime.startTurn(f.turn)))._tag).toBe("Failure");
        expect(f.opened).toEqual([]);
      }),
    ),
  );
  it.effect("completes an empty-buffer provider continuation when native recovery is omitted", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ unbound: true });
        yield* f.runtime.startTurn({
          ...f.turn,
          message: { ...f.turn.message, createdBy: "agent", creationSource: "provider" },
        });
        const events = yield* drainEvents(f.runtime.events);
        expect(events.filter((event) => event.type === "turn.terminal")).toMatchObject([
          {
            status: "completed",
            providerThreadId: f.turn.providerThread.id,
            runOrdinal: f.turn.runOrdinal,
          },
        ]);
        expect(
          events
            .filter((event) => event.type === "provider_turn.updated")
            .map((event) => event.providerTurn.status),
        ).toEqual(["running", "completed"]);
        expect(f.order).toEqual(["open"]);
        expect(f.offers).toEqual([]);
        expect(f.receipts).toEqual([]);
      }),
    ),
  );
});
