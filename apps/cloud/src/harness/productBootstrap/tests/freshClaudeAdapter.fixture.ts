import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { ClaudeNativeHostBindingOptions } from "../../ClaudeNativeHostBinding.ts";

const decodeSettings = Schema.decodeEffect(ClaudeSettings);

export const freshClaudeAdapterServices = Effect.gen(function* () {
  return {
    path: yield* Path.Path,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    mcpSessions: yield* McpProviderSessions.McpProviderSessions,
    settings: yield* decodeSettings({ binaryPath: "/runtime/claude" }),
  };
}).pipe(Effect.provide(Layer.mergeAll(Path.layer, IdAllocator.layer, McpProviderSessions.layer)));

type Services = Effect.Success<typeof freshClaudeAdapterServices>;
type AdapterOptions = Omit<ClaudeNativeHostBindingOptions["adapter"], "continuationRequests">;

export function freshClaudeAdapterWithFileSystem(
  fileSystem: FileSystem.FileSystem,
  services: Services,
  instanceId: ProviderInstanceId,
): AdapterOptions {
  return {
    instanceId,
    settings: services.settings,
    modelCatalog: { models: [] },
    attachmentsDir: "/workspace/attachments",
    path: services.path,
    idAllocator: services.idAllocator,
    fileSystem,
    crypto: Crypto.make({
      randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
      digest: (algorithm, bytes) =>
        Effect.tryPromise({
          try: async () =>
            new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, bytes.slice())),
          catch: (cause) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "Crypto",
              method: "digest",
              cause,
            }),
        }),
    }),
    host: {
      cwd: () => "/workspace",
      taskOutputRoot: () => undefined,
      resolveAttachmentPath: ({ attachmentsDir, attachment }) =>
        `${attachmentsDir}/${attachment.id}`,
      discoverSkills: () => Effect.succeed([]),
      readWorkflowAgentAnswers: () => Effect.succeed([]),
      signedOutMessage: () => "Test provider is signed out",
    },
  };
}
