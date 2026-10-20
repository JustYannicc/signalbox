import * as Effect from "effect/Effect";
import { makeCodexNativeHostBinding } from "../../CodexNativeHostBinding.ts";
import { hostFixture } from "../../tests/hostFixture.ts";
import { fixture } from "./fixture.ts";
import { adapterOptions, processFixture, readyLine } from "./preinitializedFixture.ts";
import { echoEngine } from "./wasm.ts";

export const hostBindingFixture = (beforeReply?: (method: string) => Promise<void>) =>
  Effect.gen(function* () {
    const f = yield* hostFixture;
    const context = fixture(echoEngine());
    const peer = processFixture(beforeReply);
    yield* Effect.addFinalizer(() => Effect.promise(() => context.close()));
    const release = yield* Effect.promise(() => f.codexRelease());
    const options = yield* adapterOptions();
    const instance = yield* f.make({
      release,
      buildRuntime: ({ harness }) =>
        Effect.sync(() => {
          return makeCodexNativeHostBinding({
            process: { ...context.options, computer: harness.computer },
            adapter: options,
            modelOrigins: ["https://harness-mcp.invalid"],
            mcpSessions: {
              set: () => Effect.die("Unexpected app MCP fallback"),
              read: () => Effect.succeed(undefined),
              clear: () => Effect.die("Unexpected app MCP fallback"),
            },
          });
        }),
    });
    (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
    yield* instance.host.seed("assets");
    yield* instance.host.seed("programs");
    return { f, instance, peer };
  });
