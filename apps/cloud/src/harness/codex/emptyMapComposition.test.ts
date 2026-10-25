import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createHarnessSessionFacet } from "../HarnessSessionFacet.ts";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../CodexHarnessProcess.ts";
import { fixture as adapterFixture } from "../adapter/tests/fixture.ts";
import { bindingFixture, coldThread } from "./tests/nativeBindingFixture.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
vi.mock("../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer);
const decodeMap = Schema.decodeUnknownSync(
  Schema.Struct({
    config: Schema.Struct({
      mcp_servers: Schema.Record(Schema.String, Schema.Struct({ url: Schema.String })),
    }),
  }),
);

describe("Codex empty map through AdapterHarness", () => {
  it.effect("preserves an empty map across the real facet/adapter setup handoff", () =>
    Effect.gen(function* () {
      const f = yield* bindingFixture();
      const template = yield* adapterFixture;
      launch.mockResolvedValue(f.peer.process);
      const { harness } = f;
      const facet = yield* createHarnessSessionFacet({
        threadId: harness.session.threadId,
        release: harness.release,
        computer: { open: () => ({ open: async () => harness.computer }) },
        buildRuntime: () => Effect.succeed(f.binding.factory),
        modelTransport: harness.modelTransport,
      });
      const session = yield* facet.open({ session: harness.session });
      const providerThread = { ...coldThread, nativeThreadRef: null };
      const turn = {
        ...template.turn,
        threadId: harness.session.threadId,
        providerThread,
        modelSelection: harness.session.modelSelection,
        appThread: {
          ...template.turn.appThread,
          id: harness.session.threadId,
          activeProviderThreadId: providerThread.id,
          providerInstanceId: harness.session.modelSelection.instanceId,
          modelSelection: harness.session.modelSelection,
          lineage: { ...template.turn.appThread.lineage, rootThreadId: harness.session.threadId },
        },
      };
      yield* f.binding.configureMcp({ epoch: 1, servers: {} }, new AbortController().signal, {
        method: "ensureThread",
        input: { ...harness.session, existingProviderThread: providerThread },
      });
      expect(f.sessionReads).toBe(0);
      expect(decodeMap(f.peer.requests[0]?.params).config.mcp_servers).toEqual({});
      yield* session.turn(turn);
      expect(f.peer.sent).toEqual(["thread/start", "turn/start"]);
      expect(f.sessionReads).toBe(1);
      yield* session.dispose;
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
