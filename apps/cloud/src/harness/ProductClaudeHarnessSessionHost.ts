import type { HarnessContinuationPublisher } from "./HarnessContinuations.ts";
import * as Effect from "effect/Effect";
import {
  makeClaudeRemoteNativeBinding,
  type ClaudeRemoteNativeOptions,
} from "./ClaudeRemoteNativeBinding.ts";
import { HarnessError } from "./Harness.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { HarnessProcessResumePreparedRelease } from "./processResume/contracts.ts";
import type { HarnessReleaseArtifact } from "../harnessReleases/HarnessReleaseLedger.ts";
import type { ConfiguredHarnessHook } from "../hooks/HarnessHookSettings.ts";
import {
  selectProductClaudeHostRelease,
  type ProductClaudeReleaseVariants,
} from "./ProductClaudeReleaseSelection.ts";
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

type NativeProcess = ClaudeRemoteNativeOptions["process"];
export type ProductClaudeNativeOptions = Omit<
  ClaudeRemoteNativeOptions,
  "process" | "continuations" | "mcp"
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
};
export type ProductClaudeHarnessHostOptions<G> = ProductHostOptions<
  G,
  ProductClaudeNativeOptions
> & {
  readonly continuations: HarnessContinuationPublisher;
  readonly releaseVariants: ProductClaudeReleaseVariants;
  readonly settingsHooks?: readonly ConfiguredHarnessHook[];
  /** An existing checkpoint pins the variant and must agree with session hook requirements. */
  readonly processResumeArtifact?: HarnessReleaseArtifact;
};

export interface ProductClaudeHarnessSessionHost<G> extends ProductHarnessSessionHost<G> {
  loadedPreparedRelease(): HarnessProcessResumePreparedRelease;
}

function claudeBinding<G>(
  onLoaded: (loaded: LoadedHarnessRelease) => void,
): ProductNativeBinding<G, ProductClaudeNativeOptions> {
  return {
    harness: "claude-code",
    home: (native) => native.process.identity.homedir,
    build: (native, input, ports) =>
      Effect.gen(function* () {
        onLoaded(input.loaded);
        if (input.continuationRequests === undefined)
          return yield* new HarnessError({
            operation: "open",
            message: "Claude product host requires a continuation publisher.",
          });
        return makeClaudeRemoteNativeBinding({
          ...native,
          continuations: input.continuationRequests,
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
  Effect.suspend(() => {
    if (options.native.harness !== undefined && options.native.harness !== "claude-code")
      return Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Claude product host entry/harness mismatch: expected claude-code.",
        }),
      );
    if (options.continuations === undefined)
      return Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Claude product host requires a continuation publisher.",
        }),
      );

    const selected = Effect.try({
      try: () => selectProductClaudeHostRelease(options),
      catch: (cause) =>
        new HarnessError({
          operation: "open",
          message: "Claude product release selection failed.",
          cause,
        }),
    });
    const {
      processResumeArtifact: _processResumeArtifact,
      releaseVariants: _releaseVariants,
      settingsHooks: _settingsHooks,
      ...hostOptions
    } = options;
    return selected.pipe(
      Effect.flatMap(({ artifact, release }) => {
        const releaseObserver = productLoadedPreparedReleaseObserver("claude-code", artifact);
        return createProductHost(
          { ...hostOptions, release },
          claudeBinding<G>(releaseObserver.capture),
        ).pipe(Effect.map(attachProductLoadedPreparedRelease<G>(releaseObserver)));
      }),
    );
  });
