import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunnerShape,
} from "@signalbox/provider-claude/ClaudeQueryRunner";
import type { CodexAppServerClientFactoryShape } from "@signalbox/provider-codex/clientFactory";
import { claudeWithSessionEnvironment, codexWithSessionEnvironment } from "./RunnerAdapters.ts";

/** What keeps Claude Code on the gateway, as `claudeGatewaySettings` makes it. */
const gateway = {
  apiKeyHelper: "cat '/machine/model-token'",
  env: { ANTHROPIC_BASE_URL: "https://gateway.test/anthropic", HTTPS_PROXY: "" },
};

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
        const runner = claudeWithSessionEnvironment(inner, () => secrets.current, gateway);
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

  it.effect(
    "each Claude query pins the gateway over the adapter's settings and every settings file",
    () =>
      Effect.gen(function* () {
        const seen: Array<unknown> = [];
        const inner = {
          open: (input: { readonly options: { readonly settings?: unknown } }) =>
            Effect.sync(() => void seen.push(input.options.settings)),
        } as unknown as ClaudeAgentSdkQueryRunnerShape;
        const runner = claudeWithSessionEnvironment(inner, () => ({}), gateway);
        const open = (input: unknown) => runner.open(input as ClaudeAgentSdkQueryOpenInput);

        // Passed as `--settings`, which outranks user, project and local settings (#600).
        yield* open({ options: {} });
        yield* open({
          options: {
            settings: {
              showThinkingSummaries: true,
              apiKeyHelper: "echo some-other-key",
              env: { ANTHROPIC_BASE_URL: "http://dead.invalid", MAX_THINKING_TOKENS: "8000" },
            },
          },
        });

        expect(seen).toEqual([
          gateway,
          {
            showThinkingSummaries: true,
            apiKeyHelper: gateway.apiKeyHelper,
            env: { MAX_THINKING_TOKENS: "8000", ...gateway.env },
          },
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
