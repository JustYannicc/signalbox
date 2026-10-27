import * as Effect from "effect/Effect";
import {
  makeCodexNativeHostBinding,
  type CodexNativeHostBindingOptions,
} from "./CodexNativeHostBinding.ts";
import { HarnessError } from "./Harness.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessProcessResumePreparedRelease } from "./processResume/contracts.ts";
import type { HarnessReleaseArtifact } from "../harnessReleases/HarnessReleaseLedger.ts";
import {
  attachProductLoadedPreparedRelease,
  productLoadedPreparedReleaseObserver,
} from "./ProductHarnessProcessRelease.ts";
import {
  createProductHost,
  type ProductHostOptions,
  type ProductHarnessSessionHost,
  type ProductNativeBinding,
} from "./host/product.ts";

type ProductCodexNativeOptions = Omit<CodexNativeHostBindingOptions, "process"> & {
  readonly harness: "codex";
  readonly process: Omit<
    CodexNativeHostBindingOptions["process"],
    "host" | "computer" | "stdio"
  > & {
    readonly environment: CodexNativeHostBindingOptions["process"]["environment"] & {
      readonly HOME: string;
    };
  };
};
export type ProductCodexHarnessHostOptions<G> = ProductHostOptions<G, ProductCodexNativeOptions> & {
  /** Supplied by the process-resume caller; product host selection is never inferred. */
  readonly processResumeArtifact?: HarnessReleaseArtifact;
};

export interface ProductCodexHarnessSessionHost<G> extends ProductHarnessSessionHost<G> {
  loadedPreparedRelease(): HarnessProcessResumePreparedRelease;
}

function codexBinding<G>(
  onLoaded: (loaded: LoadedHarnessRelease) => void,
): ProductNativeBinding<G, ProductCodexNativeOptions> {
  return {
    harness: "codex",
    home: (native) => {
      const home = native.process.environment.HOME;
      if (typeof home !== "string" || !home.startsWith("/"))
        throw new Error("Codex product Computer requires an absolute HOME path.");
      return home;
    },
    build: (native, input, ports) =>
      Effect.sync(() => {
        onLoaded(input.loaded);
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
              new URL(request.url).origin === mcpOrigin
                ? mcpFetch(request)
                : fallbackFetch(request),
          },
        });
      }),
  };
}

/** Use this entry when composing a Codex facet so its registered graph excludes Claude. */
export const createProductCodexHarnessSessionHost = <G>(
  options: ProductCodexHarnessHostOptions<G>,
) =>
  Effect.suspend(() => {
    if (options.native.harness !== "codex")
      return Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Codex product host entry/harness mismatch: expected codex.",
        }),
      );

    const { processResumeArtifact, ...hostOptions } = options;
    const releaseObserver = productLoadedPreparedReleaseObserver("codex", processResumeArtifact);
    return createProductHost(hostOptions, codexBinding<G>(releaseObserver.capture)).pipe(
      Effect.map(attachProductLoadedPreparedRelease<G>(releaseObserver)),
    );
  });
