import { claudeSdkModelTransport } from "../ClaudeSdkIo.ts";
import { RpcTarget } from "cloudflare:workers";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { makeClaudeNativeBinding } from "../claude/NativeBinding.ts";
import { makeClaudeSdkAdapter } from "../ClaudeSdkAdapter.ts";
import { createClaudeToolObservation } from "../ClaudeToolObservation.ts";
import {
  claudeSdkContinuationCodec,
  claudeSdkSessionCodec,
  type ClaudeCliProcessPort,
  type ClaudeSdkMethod,
  type ClaudeSdkOpenInput,
  type ClaudeSdkProcessContext,
} from "../ClaudeSdkHostProtocol.ts";
import type { ClaudeSdkHostPreparation } from "../ClaudeSdkHostTypes.ts";
import { claudeSdkDispatch } from "./dispatch.ts";

const encodeEvent = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ProviderAdapterV2Event)),
);

export async function createClaudeSdkSession(options: {
  readonly input: ClaudeSdkOpenInput;
  readonly context: ClaudeSdkProcessContext;
  readonly process: ClaudeCliProcessPort;
  readonly prepared: ClaudeSdkHostPreparation;
  readonly scope: Scope.Closeable;
}) {
  const { input, context, process: cli, prepared, scope } = options;
  const modelTransport = claudeSdkModelTransport(cli);
  const lifetime = new AbortController();
  const calls = new Map<string, AbortController>();
  const cancelled = new Set<string>();
  const reports = new Set<Promise<void>>();
  const reportErrors: unknown[] = [];
  const queueReport = (report: Parameters<ClaudeCliProcessPort["report"]>[0]) => {
    let pending: Promise<void>;
    pending = cli
      .report(report)
      .catch((cause: unknown) => {
        reportErrors.push(cause);
      })
      .finally(() => reports.delete(pending));
    reports.add(pending);
  };
  const flushReports = async () => {
    while (reports.size > 0) await Promise.all(reports);
    if (reportErrors.length > 0)
      throw new AggregateError(reportErrors, "Claude SDK reports failed");
  };
  const streams = await cli.streams();
  const exited = cli.exited();
  void exited.catch(() => undefined);
  let exitStatus: Awaited<typeof exited> | undefined;
  void exited.then(
    (status) => {
      exitStatus = status;
    },
    () => undefined,
  );
  const process = {
    ...streams,
    get exitStatus() {
      return exitStatus;
    },
    exited,
    assertCompatibility: async () => {
      await prepared.assertCompatibility();
      await cli.assertCompatibility();
      await flushReports();
    },
    abort: (reason?: unknown, signal: 9 | 15 = 15) => cli.signal(reason, signal),
    dispose: () => cli.dispose(),
  };
  const binding = makeClaudeNativeBinding(
    (nativeMcp) =>
      makeClaudeSdkAdapter({
        ...prepared,
        adapter: {
          ...prepared.adapter,
          continuationRequests: {
            offer: (request) =>
              Effect.promise(() => {
                if (request.dispatchIfCurrent !== undefined || request.clearIfCurrent !== undefined)
                  throw new Error("Claude SDK continuation callbacks require host-local ownership");
                return cli.continuation(claudeSdkContinuationCodec.encode(request));
              }),
          },
        },
        environment: context.environment,
        nativeMcp,
        process,
        launch: ({ signal: _signal, ...request }) =>
          cli.launch({ ...request, manifestSha256: input.release.manifestSha256 }),
        toolObservation: createClaudeToolObservation(({ input, toolUseId, signal }) => {
          signal.throwIfAborted();
          return cli.observeTool(input, toolUseId);
        }),
      }),
    { origin: context.mcpOrigin, fetch: modelTransport },
  );
  const runtime = await Effect.runPromise(
    binding.factory
      .open(
        {
          ...input,
          modelTransport,
        },
        {
          releaseModuleOmitted: () => undefined,
          turnMilestone: (stage) => queueReport({ type: "milestone", stage }),
          cliSpawnContext: (context) => queueReport({ type: "spawn", context }),
        },
      )
      .pipe(Scope.provide(scope)),
  );
  let stream: ReadableStream<Uint8Array> | undefined;
  let disposed: Promise<void> | undefined;
  class Session extends RpcTarget {
    async describe() {
      lifetime.signal.throwIfAborted();
      return {
        providerSession: claudeSdkSessionCodec.encode(runtime.providerSession),
        modelCatalog: prepared.adapter.modelCatalog,
      };
    }
    async events() {
      if (stream !== undefined) throw new Error("Claude SDK events already have a consumer");
      stream = await Effect.runPromise(
        runtime.events.pipe(
          Stream.tap(() => Effect.promise(flushReports)),
          Stream.map((event) => new TextEncoder().encode(`${encodeEvent(event)}\n`)),
          Stream.toReadableStreamEffect({ strategy: { highWaterMark: 0 } }),
          Scope.provide(scope),
        ),
      );
      return stream;
    }
    async execute(id: string, method: ClaudeSdkMethod, input: unknown) {
      lifetime.signal.throwIfAborted();
      if (calls.has(id) || typeof method !== "string")
        throw new Error("Invalid Claude SDK operation identity");
      const controller = new AbortController();
      calls.set(id, controller);
      if (cancelled.delete(id)) controller.abort(new Error("Claude SDK operation cancelled"));
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      try {
        const dispatch = claudeSdkDispatch(runtime, binding.configureMcp, signal);
        if (!Object.hasOwn(dispatch, method)) throw new Error("Unknown Claude SDK operation");
        const result = await Effect.runPromise(dispatch[method](input), { signal });
        await flushReports();
        return result;
      } finally {
        calls.delete(id);
      }
    }
    async cancel(id: string, reason: unknown) {
      const active = calls.get(id);
      if (active !== undefined) active.abort(reason);
      else if (cancelled.size < 64) cancelled.add(id);
    }
    dispose() {
      return (disposed ??= (async () => {
        lifetime.abort(new Error("Claude SDK owner closed"));
        for (const controller of calls.values()) controller.abort(lifetime.signal.reason);
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await flushReports();
      })());
    }
  }
  return new Session();
}
