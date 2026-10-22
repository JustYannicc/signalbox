import * as Effect from "effect/Effect";
import { makeCodexNativeHostBinding } from "./CodexNativeHostBinding.ts";
import type {
  ProductCodexNativeOptions,
  ProductHarnessHostOptions as SharedProductHarnessHostOptions,
  ProductNativeBinding,
} from "./ProductHarnessSessionHost.ts";
import { createProductHarnessSessionHost as createProductHost } from "./ProductHarnessSessionHost.ts";

export type ProductHarnessHostOptions<G> = SharedProductHarnessHostOptions<G> & {
  readonly native: ProductCodexNativeOptions;
};

function codexBinding<G>(native: ProductCodexNativeOptions): ProductNativeBinding<G> {
  return (input, ports) =>
    Effect.sync(() => {
      const { harness: _harness, process, ...bindingOptions } = native;
      const { origin: mcpOrigin, fetch: mcpFetch } = input.mcp;
      const fallbackFetch = process.fetch;
      return makeCodexNativeHostBinding({
        ...bindingOptions,
        process: {
          ...process,
          host: ports.commands.host,
          computer: ports.computer,
          stdio: ports.stdio,
          fetch: (request) =>
            new URL(request.url).origin === mcpOrigin ? mcpFetch(request) : fallbackFetch(request),
        },
      });
    });
}

/** Use this entry when composing a Codex facet so its registered graph excludes Claude. */
export const createProductHarnessSessionHost = <G>(options: ProductHarnessHostOptions<G>) =>
  createProductHost(options, codexBinding(options.native));
