import type { HarnessContinuationPublisher } from "./HarnessContinuations.ts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  makeClaudeNativeHostBinding,
  type ClaudeNativeHostBindingOptions,
} from "./ClaudeNativeHostBinding.ts";
import { HarnessError } from "./Harness.ts";
import type { HarnessHostOptions } from "./HarnessSessionHost.ts";
import {
  createProductHost,
  type ProductHostOptions,
  type ProductNativeBinding,
} from "./host/product.ts";

type RuntimeInput<G> = Parameters<HarnessHostOptions<G>["buildRuntime"]>[0];
type NativeProcess = ClaudeNativeHostBindingOptions["process"];
type ProductClaudeNativeOptions<G> = Omit<
  ClaudeNativeHostBindingOptions,
  "process" | "adapter" | "mcp"
> & {
  readonly harness?: "claude-code";
  readonly process: Omit<
    NativeProcess,
    | "host"
    | "computer"
    | "stdio"
    | "loadedRelease"
    | "modelTransport"
    | "processHandle"
    | "systemIdentity"
  >;
  readonly adapter: (
    input: RuntimeInput<G>,
  ) => Effect.Effect<
    Omit<ClaudeNativeHostBindingOptions["adapter"], "continuationRequests">,
    HarnessError,
    Scope.Scope
  >;
};
export type ProductClaudeHarnessHostOptions<G> = ProductHostOptions<
  G,
  ProductClaudeNativeOptions<G>
> & { readonly continuations: HarnessContinuationPublisher };

function claudeBinding<G>(): ProductNativeBinding<G, ProductClaudeNativeOptions<G>> {
  return {
    harness: "claude-code",
    home: (native) => native.process.identity.homedir,
    build: (native, input, ports) =>
      Effect.gen(function* () {
        const adapter = yield* native.adapter(input);
        if (input.continuationRequests === undefined)
          return yield* new HarnessError({
            operation: "open",
            message: "Claude product host requires a continuation publisher.",
          });
        return makeClaudeNativeHostBinding({
          ...native,
          adapter: { ...adapter, continuationRequests: input.continuationRequests },
          mcp: input.mcp,
          process: {
            ...native.process,
            systemIdentity: ports.commands.systemIdentity,
            host: ports.commands.host,
            computer: ports.computer,
            stdio: ports.stdio,
            loadedRelease: input.loaded,
            modelTransport: input.harness.modelTransport,
          },
        });
      }),
  };
}

/** Use this entry when composing a Claude facet so its registered graph excludes Codex. */
export const createProductClaudeHarnessSessionHost = <G>(
  options: ProductClaudeHarnessHostOptions<G>,
) =>
  Effect.suspend(() =>
    options.native.harness !== undefined && options.native.harness !== "claude-code"
      ? Effect.fail(
          new HarnessError({
            operation: "open",
            message: "Claude product host entry/harness mismatch: expected claude-code.",
          }),
        )
      : options.continuations === undefined
        ? Effect.fail(
            new HarnessError({
              operation: "open",
              message: "Claude product host requires a continuation publisher.",
            }),
          )
        : createProductHost(options, claudeBinding<G>()),
  );
