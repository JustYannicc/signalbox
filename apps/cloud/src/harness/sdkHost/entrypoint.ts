import { WorkerEntrypoint } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { rpcStubOwner } from "../../rpc/Resources.ts";
import {
  claudeSdkOpenCodec,
  type ClaudeCliProcessPort,
  type ClaudeSdkProcessContext,
  type ClaudeSdkOpenInput,
} from "../ClaudeSdkHostProtocol.ts";
import type { ClaudeSdkAdapterOptions } from "../ClaudeSdkAdapter.ts";
import type { HarnessError } from "../Harness.ts";
import { createClaudeSdkSession } from "./session.ts";
import { createClaudeSdkFiles } from "./files.ts";

export interface ClaudeSdkHostPreparation extends Pick<
  ClaudeSdkAdapterOptions,
  "adapter" | "mcpSessions" | "loadSdk" | "onQueryPreCleanupDiagnostic"
> {
  readonly assertCompatibility: () => Promise<void>;
}
export interface ClaudeSdkHostDependencies<Env> {
  readonly prepare: (input: {
    readonly env: Env;
    readonly input: ClaudeSdkOpenInput;
    readonly context: ClaudeSdkProcessContext;
    readonly files: ReturnType<typeof createClaudeSdkFiles>;
    readonly process: ClaudeCliProcessPort;
  }) => Effect.Effect<ClaudeSdkHostPreparation, HarnessError, Scope.Scope>;
}

/** Load this entry in a separate Dynamic Worker, never in the CLI's module map. */
export function createClaudeSdkHostEntrypoint<Env>(dependencies: ClaudeSdkHostDependencies<Env>) {
  return class ClaudeSdkHost extends WorkerEntrypoint<Env> {
    async open(
      raw: unknown,
      context: ClaudeSdkProcessContext,
      incoming: ClaudeCliProcessPort & { readonly dup: () => ClaudeCliProcessPort },
    ) {
      const input = claudeSdkOpenCodec.decode(raw);
      const scope = await Effect.runPromise(Scope.make());
      const process = incoming.dup();
      try {
        const processOwner = rpcStubOwner(process);
        await Effect.runPromise(
          Scope.addFinalizer(
            scope,
            Effect.sync(() => processOwner[Symbol.dispose]()),
          ),
        );
        const prepared = await Effect.runPromise(
          dependencies
            .prepare({
              env: this.env,
              input,
              context,
              files: createClaudeSdkFiles(process),
              process,
            })
            .pipe(Scope.provide(scope)),
        );
        return await createClaudeSdkSession({ input, context, process, prepared, scope });
      } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw cause;
      }
    }
  };
}
