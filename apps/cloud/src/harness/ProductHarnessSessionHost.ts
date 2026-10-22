import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { Computer } from "../computer/Computer.ts";
import {
  createProductComputer,
  type ProductComputer,
  type ProductComputerOptions,
} from "../computer/ProductComputer.ts";
import {
  createKernelSessionStdio,
  type KernelSessionOutputObserver,
} from "../kernel/KernelSessionStdio.ts";
import { KernelWakeRegistry } from "../kernel/KernelWakeRegistry.ts";
import { CHILD_PROGRAM_PATHS } from "../computer/ChildProgramSet.ts";
import {
  makeClaudeNativeHostBinding,
  type ClaudeNativeHostBindingOptions,
} from "./ClaudeNativeHostBinding.ts";
import {
  makeCodexNativeHostBinding,
  type CodexNativeHostBindingOptions,
} from "./CodexNativeHostBinding.ts";
import { HarnessError } from "./Harness.ts";
import { makeFacetLifetime } from "./facet/lifetime.ts";
import {
  createHarnessSessionHost,
  type HarnessHostOptions,
  type HarnessSessionHost,
} from "./HarnessSessionHost.ts";

type BindingInput<G> = Parameters<HarnessHostOptions<G>["bindComputer"]>[0];
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

export type ProductCodexNativeOptions = Omit<CodexNativeHostBindingOptions, "process"> & {
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

export interface ProductHarnessHostOptions<G> extends Omit<
  HarnessHostOptions<G>,
  "files" | "programs" | "bindComputer" | "buildRuntime"
> {
  readonly files: Omit<HarnessHostOptions<G>["files"], "wakes" | "stdio">;
  readonly programs: {
    readonly codes: ProductComputerOptions["programs"];
    /** Includes executable bytes and data files such as Git templates, each with its own mode. */
    readonly seed: HarnessHostOptions<G>["programs"];
  };
  readonly commands: Omit<
    ProductComputerOptions,
    "filesystem" | "wakes" | "programs" | "signal" | "home" | "parent"
  >;
  readonly hydrate?: (input: BindingInput<G>) => Promise<void>;
  readonly observeOutput?: KernelSessionOutputObserver;
  readonly save: (input: BindingInput<G>) => ReturnType<Computer["save"]>;
  readonly port: Computer["port"];
  readonly native: ProductClaudeNativeOptions<G> | ProductCodexNativeOptions;
}

export interface ProductHarnessSessionHost<G> extends HarnessSessionHost<G> {
  /** Available after open; this is the exact Computer passed to the official native binding. */
  readonly computer: Computer;
  readonly commands: ProductComputer;
}

// Anything that outlives open is built outside createProductHarnessSessionHost; closures there
// keep options, and its release source, alive.
const acquireWakes = Effect.acquireRelease(
  Effect.sync(() => new KernelWakeRegistry()),
  (value) => Effect.sync(() => value.dispose()),
);
function acquireStdio(
  wakes: KernelWakeRegistry,
  signal: AbortSignal,
  observe?: KernelSessionOutputObserver,
) {
  return Effect.acquireRelease(
    Effect.sync(() => createKernelSessionStdio(wakes, signal, observe)),
    (value) => Effect.promise(() => value.dispose()),
  );
}

// Runtime callbacks share a V8 context, so this scope must never receive release sources.
function createProductBindings<G>(
  options: Pick<ProductHarnessHostOptions<G>, "commands" | "native" | "hydrate" | "port" | "save">,
  codes: ProductComputerOptions["programs"],
  wakes: KernelWakeRegistry,
  stdio: ReturnType<typeof createKernelSessionStdio>,
  close: Effect.Effect<void>,
) {
  let commands: ProductComputer | undefined;
  let computer: Computer | undefined;
  return {
    bindComputer: (input: BindingInput<G>) =>
      Effect.gen(function* () {
        stdio.assertBound(input.files);
        const bound = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              createProductComputer({
                ...options.commands,
                filesystem: input.files,
                wakes,
                programs: codes,
                home: productComputerHome(options.native),
                signal: input.signal,
              }),
            catch: (cause) =>
              new HarnessError({
                operation: "open",
                message: "Product Computer could not be opened.",
                cause,
              }),
          }),
          (value) => Effect.promise(() => value.close()),
        );
        commands = bound;
        // Hydration can hold canonical files; cancellation must join it before they close.
        yield* Effect.tryPromise({
          try: async () => {
            input.signal.throwIfAborted();
            await options.hydrate?.(input);
            input.signal.throwIfAborted();
          },
          catch: (cause) =>
            new HarnessError({
              operation: "open",
              message: "Product files could not be hydrated.",
              cause,
            }),
        }).pipe(Effect.uninterruptible);
        return {
          exec: bound.exec,
          port: (port: number, signal: AbortSignal) => {
            const owned = AbortSignal.any([input.signal, signal]);
            owned.throwIfAborted();
            return options.port(port, owned);
          },
          save: (signal: AbortSignal) => {
            const owned = AbortSignal.any([input.signal, signal]);
            owned.throwIfAborted();
            return options.save({ ...input, signal: owned });
          },
        };
      }),
    buildRuntime: (input: RuntimeInput<G>) =>
      Effect.gen(function* () {
        const bound = commands;
        const native = options.native;
        const releaseHarness = input.loaded.plan.release.harness;
        const nativeHarness = native.harness ?? "claude-code";
        if (bound === undefined || releaseHarness !== nativeHarness)
          return yield* new HarnessError({
            operation: "open",
            message: "Product host native binding does not match the verified release.",
          });
        computer = input.harness.computer;
        if (native.harness === "codex") {
          const { harness: _harness, process, ...bindingOptions } = native;
          const { origin: mcpOrigin, fetch: mcpFetch } = input.mcp;
          const fallbackFetch = process.fetch;
          return makeCodexNativeHostBinding({
            ...bindingOptions,
            process: {
              ...process,
              host: bound.host,
              computer,
              stdio,
              fetch: (request) =>
                new URL(request.url).origin === mcpOrigin
                  ? mcpFetch(request)
                  : fallbackFetch(request),
            },
          });
        }
        const adapter = yield* native.adapter(input);
        return makeClaudeNativeHostBinding({
          ...native,
          adapter,
          mcp: input.mcp,
          process: {
            ...native.process,
            host: bound.host,
            computer,
            stdio,
            loadedRelease: input.loaded,
            modelTransport: input.harness.modelTransport,
          },
        });
      }),
    wrap(host: HarnessSessionHost<G>): ProductHarnessSessionHost<G> {
      return {
        ...host,
        dispose: close.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new HarnessError({
                operation: "dispose",
                message: "Product host cleanup failed.",
                cause,
              }),
            ),
          ),
        ),
        get computer() {
          if (computer === undefined)
            throw new Error("Open the product host before using Computer");
          return computer;
        },
        get commands() {
          if (commands === undefined)
            throw new Error("Open the product host before using commands");
          return commands;
        },
      };
    },
  };
}

function productComputerHome<G>(native: ProductHarnessHostOptions<G>["native"]) {
  if (native.harness !== "codex") return native.process.identity.homedir;
  const home = native.process.environment.HOME;
  if (typeof home !== "string" || !home.startsWith("/"))
    throw new Error("Codex product Computer requires an absolute HOME path.");
  return home;
}

/** Public product composition. Platform callers never assemble a private Computer or runtime. */
export const createProductHarnessSessionHost = <G>(
  options: ProductHarnessHostOptions<G>,
): Effect.Effect<ProductHarnessSessionHost<G>, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
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
    const owner = yield* makeFacetLifetime(yield* Scope.Scope);
    return yield* Effect.gen(function* () {
      const wakes = yield* acquireWakes;
      const stdio = yield* acquireStdio(wakes, owner.signal, options.observeOutput);
      const { release: _release, programs, ...runtime } = options;
      const bindings = createProductBindings<G>(runtime, programs.codes, wakes, stdio, owner.close);
      const host = yield* createHarnessSessionHost(
        {
          ...options,
          files: { ...options.files, wakes, stdio: stdio.stdio },
          programs: options.programs.seed,
          bindComputer: bindings.bindComputer,
          buildRuntime: bindings.buildRuntime,
        },
        owner.close,
      );
      return bindings.wrap(host);
    }).pipe(
      Scope.provide(owner.scope),
      Effect.onError(() => owner.close),
    );
  });
