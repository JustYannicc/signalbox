import * as Effect from "effect/Effect";
import { ClaudeCliProcess, type ClaudeCliProcessOptions } from "./ClaudeCliProcess.ts";
import { HarnessError } from "./Harness.ts";
import type { NativeHostBinding } from "./HarnessSessionHost.ts";
import type { HarnessContinuationRequests } from "./HarnessContinuations.ts";
import type { HarnessProcessObserver } from "./HarnessProcessLifetime.ts";
import type { ClaudeToolObservation } from "./ClaudeToolObservation.ts";
import { claudeSdkContinuationCodec, type ClaudeSdkHostService } from "./ClaudeSdkHostProtocol.ts";
import { makeClaudeSdkNativeBinding } from "./ClaudeSdkNativeBinding.ts";

export interface ClaudeRemoteNativeOptions {
  readonly process: ClaudeCliProcessOptions;
  readonly sdkHost: ClaudeSdkHostService;
  readonly continuations: HarnessContinuationRequests;
  readonly mcp: {
    readonly origin: string;
    readonly fetch: (request: Request) => Promise<Response>;
  };
  readonly processObserver?: HarnessProcessObserver;
  readonly toolObservation?: ClaudeToolObservation;
}
export function makeClaudeRemoteNativeBinding(
  options: ClaudeRemoteNativeOptions,
): NativeHostBinding {
  return makeClaudeSdkNativeBinding({
    sdkHost: options.sdkHost,
    context: {
      identity: options.process.identity,
      environment: options.process.env,
      cwd: options.process.computer.files.cwd,
      mcpOrigin: options.mcp.origin,
    },
    openCli: (input, reporter) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const cli = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              new ClaudeCliProcess(
                options.process,
                {
                  ...input,
                  modelTransport: (request) =>
                    new URL(request.url).origin === options.mcp.origin
                      ? options.mcp.fetch(request)
                      : input.modelTransport(request),
                },
                reporter,
                options.toolObservation === undefined
                  ? undefined
                  : async (input, toolUseId, signal) => {
                      await options.toolObservation?.hooks[input.hook_event_name]?.[0]?.hooks[0]?.(
                        input,
                        toolUseId,
                        { signal },
                      );
                    },
                (request, signal) =>
                  Effect.runPromiseWith(context)(
                    options.continuations.offer(claudeSdkContinuationCodec.decode(request)),
                    { signal },
                  ),
              ),
            catch: (cause) =>
              new HarnessError({
                operation: "open",
                message: "Claude CLI process could not open.",
                cause,
              }),
          }),
          (cli) => Effect.promise(() => cli.dispose()),
        );
        yield* Effect.try({
          try: () => cli.observeOwner(options.processObserver),
          catch: (cause) =>
            new HarnessError({
              operation: "open",
              message: "Claude CLI ownership could not be recorded.",
              cause,
            }),
        });
        return cli;
      }),
  });
}
