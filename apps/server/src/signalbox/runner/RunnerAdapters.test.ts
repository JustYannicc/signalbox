import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunnerShape,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { CodexAppServerClientFactoryShape } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { claudeWithSessionEnvironment, codexWithSessionEnvironment } from "./RunnerAdapters.ts";

/** The folder's secrets as they stand when each session opens. */
const secrets = { current: { API_KEY: "first", HOME: "/not/the/machine/home" } };
const machine = { HOME: "/machine/home", PATH: "/usr/bin" };

describe("harness sessions", () => {
  it.effect(
    "each Claude query gets the secrets as they are when it opens, under the machine's",
    () =>
      Effect.gen(function* () {
        const seen: Array<unknown> = [];
        const inner = {
          open: (input: { readonly options: { readonly env?: unknown } }) =>
            Effect.sync(() => void seen.push(input.options.env)),
        } as unknown as ClaudeAgentSdkQueryRunnerShape;
        const runner = claudeWithSessionEnvironment(inner, () => secrets.current);
        const open = (input: unknown) => runner.open(input as ClaudeAgentSdkQueryOpenInput);

        yield* open({ options: { env: machine } });
        secrets.current = { API_KEY: "second", HOME: "/not/the/machine/home" };
        yield* open({ options: { env: machine } });

        expect(seen).toEqual([
          { API_KEY: "first", HOME: "/machine/home", PATH: "/usr/bin" },
          { API_KEY: "second", HOME: "/machine/home", PATH: "/usr/bin" },
        ]);
      }),
  );

  it.effect("each Codex app-server gets them the same way", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Array<unknown> = [];
        const inner = {
          open: (input: { readonly environment: unknown }) =>
            Effect.sync(() => void seen.push(input.environment)),
        } as unknown as CodexAppServerClientFactoryShape;
        const factory = codexWithSessionEnvironment(inner, () => ({ API_KEY: "codex-key" }));

        yield* factory.open({ environment: machine } as unknown as Parameters<
          CodexAppServerClientFactoryShape["open"]
        >[0]);

        expect(seen).toEqual([{ API_KEY: "codex-key", HOME: "/machine/home", PATH: "/usr/bin" }]);
      }),
    ),
  );
});
