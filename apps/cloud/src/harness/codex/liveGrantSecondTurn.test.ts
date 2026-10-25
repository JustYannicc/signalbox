import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../CodexHarnessProcess.ts";
import { runLiveGrantSecondTurn } from "./tests/liveGrantSecondTurn.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
vi.mock("../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const launchPeer = (process: CodexHarnessProcess, onLaunch: () => void) => {
  launch.mockClear();
  launch.mockImplementation(async () => {
    onLaunch();
    return process;
  });
};

describe("Codex host live-access second turns", () => {
  it.effect("starts the next ordinary turn after terminal with the same live access", () =>
    runLiveGrantSecondTurn(launchPeer).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.handshakeRejected).toBe(false);
          expect(result.firstRouteBody).toBe("executor");
          expect(result.secondTurnStarted).toBe(true);
          expect(result.processLaunches).toBe(1);
          expect(result.nativeMethods).toEqual([
            "thread/start",
            "turn/start",
            "thread/read",
            "thread/resume",
            "turn/start",
          ]);
          expect(result.firstNativeThreadId).toBe("preinitialized-native-thread");
          expect(result.resumedNativeThreadId).toBe(result.firstNativeThreadId);
          expect(result.firstRouteEpoch).toBe(1);
          expect(result.secondRouteEpoch).toBe(2);
          expect(result.firstRouteRetired).toBe(true);
          expect(result.secondRouteBody).toBe("executor");
          expect(result.secondRouteRetired).toBe(true);
          expect(result.accessStayedLive).toBe(true);
          expect(result.currentRouteGrantMatches).toBe(true);
        }),
      ),
      Effect.scoped,
      Effect.provide(layer),
    ),
  );

  it.effect("starts after a synthetic first MCP initialize failure with the same guard state", () =>
    runLiveGrantSecondTurn(launchPeer, true).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.handshakeRejected).toBe(true);
          expect(result.firstRouteBody).toBe("executor");
          expect(result.secondTurnStarted).toBe(true);
          expect(result.processLaunches).toBe(1);
          expect(result.nativeMethods).toEqual([
            "thread/start",
            "turn/start",
            "thread/read",
            "thread/resume",
            "turn/start",
          ]);
          expect(result.firstNativeThreadId).toBe("preinitialized-native-thread");
          expect(result.resumedNativeThreadId).toBe(result.firstNativeThreadId);
          expect(result.firstRouteEpoch).toBe(1);
          expect(result.secondRouteEpoch).toBe(2);
          expect(result.firstRouteRetired).toBe(true);
          expect(result.secondRouteBody).toBe("executor");
          expect(result.secondRouteRetired).toBe(true);
          expect(result.accessStayedLive).toBe(true);
          expect(result.currentRouteGrantMatches).toBe(true);
        }),
      ),
      Effect.scoped,
      Effect.provide(layer),
    ),
  );
});
