import * as Effect from "effect/Effect";
import { makeClaudeNativeHostBinding } from "./ClaudeNativeHostBinding.ts";
import type {
  ProductClaudeNativeOptions,
  ProductHarnessHostOptions as SharedProductHarnessHostOptions,
  ProductNativeBinding,
} from "./ProductHarnessSessionHost.ts";
import { createProductHarnessSessionHost as createProductHost } from "./ProductHarnessSessionHost.ts";

export type ProductHarnessHostOptions<G> = SharedProductHarnessHostOptions<G> & {
  readonly native: ProductClaudeNativeOptions<G>;
};

function claudeBinding<G>(native: ProductClaudeNativeOptions<G>): ProductNativeBinding<G> {
  return (input, ports) =>
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
    });
}

/** Use this entry when composing a Claude facet so its registered graph excludes Codex. */
export const createProductHarnessSessionHost = <G>(options: ProductHarnessHostOptions<G>) =>
  createProductHost(options, claudeBinding(options.native));
