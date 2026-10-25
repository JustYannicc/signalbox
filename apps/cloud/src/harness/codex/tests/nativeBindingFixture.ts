import { CODEX_DRIVER_KIND } from "@signalbox/provider-codex/defaults";
import { ProviderThreadId, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { type HarnessOpenInput } from "../../Harness.ts";
import { makeCodexNativeHostBinding } from "../../CodexNativeHostBinding.ts";
import { fixture } from "./fixture.ts";
import { adapterOptions, processFixture, readyLine, session } from "./preinitializedFixture.ts";
import { echoEngine } from "./wasm.ts";

export const coldThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("binding-thread"),
  driver: CODEX_DRIVER_KIND,
  providerInstanceId: session.modelSelection.instanceId,
  providerSessionId: session.providerSessionId,
  appThreadId: session.threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: CODEX_DRIVER_KIND,
    nativeId: "preinitialized-native-thread",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "not_loaded",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
};

/** The launch port returns a scripted protocol peer; this fixture proves no official native boot. */
export const bindingFixture = (beforeReply?: (method: string) => Promise<void>) =>
  Effect.gen(function* () {
    const context = fixture(echoEngine(), session.threadId);
    const peer = processFixture(beforeReply);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await peer.process.abort();
        await context.close();
      }),
    );
    const computer = context.options.computer;
    let sessionReads = 0;
    const harness: HarnessOpenInput = {
      release: { harness: "codex", version: "test", manifestSha256: "test", modules: {} },
      session,
      computer,
      modelTransport: async () => {
        throw new Error("Unexpected model request");
      },
    };
    const binding = makeCodexNativeHostBinding({
      process: { ...context.options, computer },
      adapter: yield* adapterOptions(),
      mcpSessions: {
        set: () => Effect.die("Unexpected app MCP fallback"),
        read: () =>
          Effect.sync(() => {
            sessionReads++;
            return undefined;
          }),
        clear: () => Effect.die("Unexpected app MCP fallback"),
      },
      modelOrigins: ["https://harness-mcp.invalid"],
    });
    (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
    return {
      context,
      peer,
      binding,
      harness,
      get sessionReads() {
        return sessionReads;
      },
    };
  });
