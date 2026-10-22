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
    "host" | "computer" | "stdio" | "loadedRelease" | "modelTransport" | "processHandle"
  >;
  readonly adapter: (
    input: RuntimeInput<G>,
  ) => Effect.Effect<ClaudeNativeHostBindingOptions["adapter"], HarnessError, Scope.Scope>;
};
export type ProductClaudeHarnessHostOptions<G> = ProductHostOptions<
  G,
  ProductClaudeNativeOptions<G>
>;

function claudeBinding<G>(): ProductNativeBinding<G, ProductClaudeNativeOptions<G>> {
  return {
    harness: "claude-code",
    home: (native) => native.process.identity.homedir,
    build: (native, input, ports) =>
      Effect.gen(function* () {
        const adapter = yield* native.adapter(input);
        return makeClaudeNativeHostBinding({
          ...native,
          adapter,
          mcp: input.mcp,
          process: {
            ...native.process,
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
      : createProductHost(options, claudeBinding<G>()),
  );
