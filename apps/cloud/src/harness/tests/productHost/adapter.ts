import { ClaudeSettings } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { ClaudeNativeHostBindingOptions } from "../../ClaudeNativeHostBinding.ts";

const decodeSettings = Schema.decodeEffect(ClaudeSettings);

export const services = Effect.gen(function* () {
  return {
    path: yield* Path.Path,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    mcpSessions: yield* McpProviderSessions.McpProviderSessions,
    settings: yield* decodeSettings({ binaryPath: "/runtime/claude" }),
  };
}).pipe(Effect.provide(Layer.mergeAll(Path.layer, IdAllocator.layer, McpProviderSessions.layer)));

export function adapter(
  files: KernelFileSystem,
  deps: Effect.Success<typeof services>,
  instanceId: ClaudeNativeHostBindingOptions["adapter"]["instanceId"],
): ClaudeNativeHostBindingOptions["adapter"] {
  const fs = createNodeFs(files).fs;
  const access = <A>(method: string, path: string, run: () => A) =>
    Effect.try({
      try: run,
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method,
          pathOrDescriptor: path,
          cause,
        }),
    });
  return {
    instanceId,
    settings: deps.settings,
    modelCatalog: { models: [] },
    attachmentsDir: "/workspace/attachments",
    path: deps.path,
    idAllocator: deps.idAllocator,
    fileSystem: FileSystem.makeNoop({
      exists: (path) => access("exists", path, () => fs.existsSync(path)),
      readDirectory: (path) =>
        access("readDirectory", path, () => fs.readdirSync(path).map(String)),
      readFileString: (path) =>
        access("readFileString", path, () => String(fs.readFileSync(path, "utf8"))),
      makeDirectory: (path, options) =>
        access("makeDirectory", path, () => {
          fs.mkdirSync(
            path,
            options?.recursive === undefined ? undefined : { recursive: options.recursive },
          );
        }),
    }),
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
