import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { NodeBridge } from "../../../isolate/NodeBridge.ts";
import type { ClaudeNativeHostBindingOptions } from "../../ClaudeNativeHostBinding.ts";
import { claudeSdkOpenCodec, type ClaudeSdkHostService } from "../../ClaudeSdkHostProtocol.ts";
import {
  claudeSdkFileSystem,
  createClaudeSdkFiles,
  createClaudeSdkSession,
  type ClaudeSdkHostPreparation,
} from "../../ClaudeSdkHost.ts";
import type * as FileSystem from "effect/FileSystem";
import type { HarnessError } from "../../Harness.ts";

/** Controlled SDK bytes share a test realm. Workerd tests cover the real cross-isolate port. */
export function sdkHostFixture(options: {
  readonly adapter: (
    files: FileSystem.FileSystem,
  ) => Effect.Effect<ClaudeSdkHostPreparation["adapter"], HarnessError, Scope.Scope>;
  readonly mcpSessions: ClaudeNativeHostBindingOptions["mcpSessions"];
  readonly loadSdk: ClaudeNativeHostBindingOptions["loadSdk"];
}): ClaudeSdkHostService {
  return {
    async open(raw, context, process) {
      const scope = await Effect.runPromise(Scope.make());
      try {
        const adapter = await Effect.runPromise(
          options
            .adapter(claudeSdkFileSystem(createClaudeSdkFiles(process)))
            .pipe(Scope.provide(scope)),
        );
        const bridge = Reflect.get(globalThis, Symbol.for("signalbox.nodeBridge.v1")) as NodeBridge;
        if (bridge === undefined) throw new Error("The controlled CLI has no Node personality");
        return await createClaudeSdkSession({
          input: claudeSdkOpenCodec.decode(raw),
          context,
          process,
          scope,
          prepared: {
            adapter,
            mcpSessions: options.mcpSessions,
            loadSdk: (signal) => options.loadSdk(bridge, signal),
            assertCompatibility: async () => {},
          },
        });
      } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw cause;
      }
    },
  };
}
