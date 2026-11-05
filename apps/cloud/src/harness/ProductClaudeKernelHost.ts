import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { HarnessError } from "./Harness.ts";
import type { Computer } from "../computer/Computer.ts";
import type { ComputerExecutionConfiguration } from "../computer/ComputerExecutionObject.ts";
import { ComputerExecutionPort } from "../computer/ComputerExecutionPort.ts";
import type { ComputerProgramOwnerPort } from "../kernel/KernelComputerAdmissionPort.ts";
import type { HarnessHostResources } from "./HarnessHostResources.ts";
import type { HarnessHostOptions, HarnessSessionHost, ProgramSeed } from "./host/contracts.ts";
import type { ClaudeKernelInitialize, ClaudeKernelSessionPort } from "./ClaudeKernelSessionPort.ts";
import type { ClaudeSdkHostService } from "./ClaudeSdkHostProtocol.ts";
import type { ClaudeToolObservation } from "./ClaudeToolObservation.ts";
import type { HarnessFilesStoreResult } from "./HarnessFilesStore.ts";
import type { FacetStorage } from "../kernel/FacetSqliteStorage.ts";
import type { MachineProgramInventory } from "../computer/MachineProgramInventory.ts";
import type { HarnessContinuationPublisher } from "./HarnessContinuations.ts";
import type { HarnessReleaseArtifact } from "../harnessReleases/HarnessReleaseLedger.ts";
import type { ConfiguredHarnessHook } from "../hooks/HarnessHookSettings.ts";
import { loadHarnessRelease, type LoadHarnessReleaseOptions } from "./HarnessReleaseLoader.ts";
import {
  selectProductClaudeHostRelease,
  type ProductClaudeReleaseVariants,
} from "./ProductClaudeReleaseSelection.ts";
import { productLoadedPreparedReleaseObserver } from "./ProductHarnessProcessRelease.ts";
import { makeFacetLifetime } from "./facet/lifetime.ts";
import { createHostLifecycle } from "./host/lifecycle.ts";
import { createSeedCatalog } from "./host/seed.ts";
import { ClaudeKernelHostSeed } from "./ClaudeKernelHostSeed.ts";
import { ClaudeKernelHostCallbacks } from "./ClaudeKernelHostCallbacks.ts";
import { claudeKernelOperation } from "./ClaudeKernelOperation.ts";
import { claudeKernelComputer } from "./ClaudeKernelComputer.ts";
import { makeClaudeSdkNativeBinding } from "./ClaudeSdkNativeBinding.ts";
import { claudeSdkContinuationCodec } from "./ClaudeSdkHostProtocol.ts";
import { KernelFileTransfer, kernelFileTransferManifest } from "../kernel/KernelFileTransfer.ts";
import { validateHarnessCProductFiles } from "./productBootstrap/filesCheckpoint.ts";
import { CHILD_PROGRAM_PATHS } from "../computer/ChildProgramSet.ts";

export interface ProductClaudeKernelHostOptions<G> extends Pick<
  HarnessHostOptions<G>,
  "threadId" | "modelTransport" | "hooks" | "executor" | "turnGrantSource"
> {
  readonly release: LoadHarnessReleaseOptions;
  readonly releaseVariants: ProductClaudeReleaseVariants;
  readonly processResumeArtifact?: HarnessReleaseArtifact;
  readonly settingsHooks?: readonly ConfiguredHarnessHook[];
  readonly continuations: HarnessContinuationPublisher;
  readonly programs: {
    readonly codes: import("../computer/CommandGateway.ts").CommandProgramCodes;
    readonly seed: ProgramSeed;
  };
  readonly machineInventory: MachineProgramInventory;
  readonly sessionKey: string;
  readonly nativeSessionId?: string;
  readonly files: ClaudeKernelInitialize["files"] & { readonly database: FacetStorage };
  readonly filesCheckpoint?: HarnessFilesStoreResult;
  readonly kernel: ClaudeKernelSessionPort;
  readonly commands: ComputerProgramOwnerPort & {
    configure(input: ComputerExecutionConfiguration): Promise<void>;
  };
  readonly admission: Omit<ComputerExecutionConfiguration, "programs">;
  readonly native: {
    readonly sdkHost: ClaudeSdkHostService;
    readonly process: ClaudeKernelInitialize["process"];
    readonly toolObservation?: ClaudeToolObservation;
    readonly reportCliStartupFailure?: (cause: unknown) => void;
  };
  readonly observeOutput?: (fd: number, bytes: Uint8Array) => void;
  readonly observeInput?: (bytes: Uint8Array) => void;
}

export interface ProductClaudeKernelHost<G> extends HarnessSessionHost<G> {
  readonly computer: Computer<unknown>;
  loadedPreparedRelease(): import("./processResume/contracts.ts").HarnessProcessResumePreparedRelease;
}

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new HarnessError({ operation: "open", message, cause }),
  });

/** The public Claude host coordinates three owners: this DO, Computer, and the retained CLI kernel. */
export const createProductClaudeKernelHost = <G>(
  options: ProductClaudeKernelHostOptions<G>,
): Effect.Effect<ProductClaudeKernelHost<G>, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* makeFacetLifetime(yield* Scope.Scope);
    return yield* Effect.gen(function* () {
      const selected = yield* Effect.try({
        try: () => selectProductClaudeHostRelease(options),
        catch: (cause) =>
          new HarnessError({
            operation: "open",
            message: "Claude product release selection failed.",
            cause,
          }),
      });
      const loaded = yield* attempt("Claude product release could not be verified.", () =>
        loadHarnessRelease(selected.release),
      );
      const catalog = yield* attempt("Claude kernel seed catalog is invalid.", () =>
        createSeedCatalog(loaded, options.programs.seed, options.files, {
          artifact: selected.release.identity,
          computer: loaded.plan.computer,
          thread: options.threadId,
          filesystem: options.files.identity,
        }),
      );
      yield* Effect.try({
        try: () => {
          for (const path of Object.values(CHILD_PROGRAM_PATHS)) {
            const entry = options.programs.seed.files[path];
            if (entry === undefined || (entry.mode & 0o111) === 0)
              throw new Error(`Product executable seed is missing or not executable: ${path}`);
          }
        },
        catch: (cause) =>
          new HarnessError({
            operation: "open",
            message: "Product host requires the full executable seed manifest.",
            cause,
          }),
      });
      const callbacks = new ClaudeKernelHostCallbacks({
        signal: owner.signal,
        ...(options.native.toolObservation === undefined
          ? {}
          : { toolObservation: options.native.toolObservation }),
        ...(options.native.reportCliStartupFailure === undefined
          ? {}
          : { startup: options.native.reportCliStartupFailure }),
        ...(options.observeOutput === undefined ? {} : { output: options.observeOutput }),
        ...(options.observeInput === undefined ? {} : { input: options.observeInput }),
      });
      const source = new ClaudeKernelHostSeed(catalog, loaded, owner.signal);
      const closeResources = async () => {
        const failures: unknown[] = [];
        for (const close of [
          () => options.kernel.close(),
          () => options.commands.close(),
          () => callbacks.close(),
          () => source.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(failures, "Claude product owners could not close");
      };
      const resources = Effect.acquireRelease(
        attempt(
          "Claude kernel could not bind its owners.",
          async (): Promise<HarnessHostResources<string>> => {
            const initialized = await options.kernel.initialize({
              threadId: options.threadId,
              sessionKey: options.sessionKey,
              ...(options.nativeSessionId === undefined
                ? {}
                : { nativeSessionId: options.nativeSessionId }),
              process: options.native.process,
              files: {
                identity: options.files.identity,
                rootMetadata: options.files.rootMetadata,
                posix: options.files.posix,
                cwd: options.files.cwd,
                assetMode: options.files.assetMode,
              },
              machineInventory: options.machineInventory,
            });
            if (options.filesCheckpoint !== undefined) {
              validateHarnessCProductFiles(options.filesCheckpoint.files);
              const transfer = new KernelFileTransfer(options.filesCheckpoint.files);
              try {
                await options.kernel.materialize(
                  kernelFileTransferManifest(options.filesCheckpoint.files),
                  transfer,
                );
              } finally {
                await transfer.close();
              }
            }
            await options.commands.configure({
              ...options.admission,
              programs: options.programs.codes,
            });
            await options.kernel.configure({
              threadId: options.threadId,
              process: options.native.process,
              loaded: { plan: loaded.plan },
              catalog: { id: catalog.id, stages: catalog.stages },
              owner: new ComputerExecutionPort(options.commands),
              source,
              callbacks,
            });
            return {
              database: options.files.database,
              fileIdentity: initialized.fileIdentity,
              boot: {
                check: () => owner.signal.throwIfAborted(),
                seed: async (stage, signal) => {
                  signal.throwIfAborted();
                  await claudeKernelOperation(options.kernel, signal, (id) =>
                    options.kernel.seed(stage, id),
                  );
                  signal.throwIfAborted();
                },
                claim: async (id, hash, signal) => {
                  signal.throwIfAborted();
                  await claudeKernelOperation(options.kernel, signal, (operationId) =>
                    options.kernel.claim(id, hash, operationId),
                  );
                  signal.throwIfAborted();
                },
              },
              bindComputer: (signal) =>
                attempt("Claude kernel files could not be prepared.", async () => {
                  signal.throwIfAborted();
                  await claudeKernelOperation(options.kernel, signal, (id) =>
                    options.kernel.prepare(id),
                  );
                  signal.throwIfAborted();
                  return claudeKernelComputer(
                    options.kernel,
                    options.threadId,
                    initialized.fileIdentity,
                    signal,
                  );
                }),
            };
          },
        ).pipe(Effect.onError(() => Effect.promise(closeResources))),
        () => Effect.promise(closeResources),
      );
      const observed = productLoadedPreparedReleaseObserver("claude-code", selected.artifact);
      let computer: Computer<unknown> | undefined;
      const host = yield* createHostLifecycle(
        {
          threadId: options.threadId,
          modelTransport: options.modelTransport,
          executor: options.executor,
          continuations: options.continuations,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.turnGrantSource === undefined
            ? {}
            : { turnGrantSource: options.turnGrantSource }),
          buildRuntime: (input) =>
            Effect.gen(function* () {
              if (input.continuationRequests === undefined)
                return yield* new HarnessError({
                  operation: "open",
                  message: "Claude product host requires continuation requests.",
                });
              observed.capture(input.loaded);
              computer = input.harness.computer;
              const context = yield* Effect.context<never>();
              const requests = input.continuationRequests;
              return makeClaudeSdkNativeBinding<string>({
                sdkHost: options.native.sdkHost,
                context: {
                  identity: options.native.process.identity,
                  environment: options.native.process.env,
                  cwd: options.files.cwd,
                  mcpOrigin: input.mcp.origin,
                },
                openCli: (harness, reporter) =>
                  Effect.gen(function* () {
                    callbacks.bind({
                      model: (request) =>
                        new URL(request.url).origin === input.mcp.origin
                          ? input.mcp.fetch(request)
                          : harness.modelTransport(request),
                      reporter,
                      continuation: (value) =>
                        Effect.runPromiseWith(context)(
                          requests.offer(claudeSdkContinuationCodec.decode(value)),
                          { signal: input.signal },
                        ),
                    });
                    const {
                      computer: _computer,
                      modelTransport: _model,
                      hooks: _hooks,
                      loadedRelease: _loaded,
                      ...open
                    } = harness;
                    return yield* Effect.acquireRelease(
                      attempt("Claude kernel process could not open.", () =>
                        options.kernel.open(open),
                      ),
                      (process) => Effect.promise(() => process.dispose()),
                    );
                  }),
              });
            }),
        },
        loaded,
        resources,
        owner.close,
      );
      return {
        ...host,
        dispose: owner.close.pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError({
                operation: "dispose",
                message: "Claude product host cleanup failed.",
                cause,
              }),
          ),
        ),
        get computer() {
          if (computer === undefined)
            throw new Error("Open the product host before using Computer");
          return computer;
        },
        loadedPreparedRelease: observed.read,
      };
    }).pipe(
      Scope.provide(owner.scope),
      Effect.onError(() => owner.close),
    );
  });
