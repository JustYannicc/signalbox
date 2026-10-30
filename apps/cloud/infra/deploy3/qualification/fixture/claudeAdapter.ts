import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { layerCrypto } from "../../../../src/platform.ts";
import { createNodeFs } from "../../../../src/isolate/NodeFs.ts";
import type { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import type { ClaudeNativeHostBindingOptions } from "../../../../src/harness/ClaudeNativeHostBinding.ts";
import { HarnessError } from "../../../../src/harness/Harness.ts";

type ClaudeAdapter = ClaudeNativeHostBindingOptions["adapter"];
const adapterLayer = Layer.mergeAll(Path.layer, IdAllocator.layer, layerCrypto);
const decodeSettings = Schema.decodeUnknownSync(ClaudeSettings);

function fileSystem(files: KernelFileSystem): FileSystem.FileSystem {
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
  return FileSystem.makeNoop({
    exists: (path) => access("exists", path, () => fs.existsSync(path)),
    readDirectory: (path) => access("readDirectory", path, () => fs.readdirSync(path).map(String)),
    readFileString: (path) =>
      access("readFileString", path, () => String(fs.readFileSync(path, "utf8"))),
    makeDirectory: (path, options) =>
      access("makeDirectory", path, () => {
        fs.mkdirSync(
          path,
          options?.recursive === undefined ? undefined : { recursive: options.recursive },
        );
      }),
  });
}

/** Uses the real Claude adapter and Computer filesystem while keeping tools authority injected. */
export function buildClaudeAdapter(input: {
  readonly files: KernelFileSystem;
  readonly instanceId: ClaudeAdapter["instanceId"];
  readonly attachmentsDir: string;
}): Effect.Effect<ClaudeAdapter, HarnessError> {
  return Effect.gen(function* () {
    const settings = yield* Effect.try({
      try: () => decodeSettings({ binaryPath: "/runtime/claude" }),
      catch: (cause) =>
        new HarnessError({
          operation: "open",
          message: "Claude fixture settings could not be built.",
          cause,
        }),
    });
    const dependencies = yield* Effect.gen(function* () {
      return {
        path: yield* Path.Path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        crypto: yield* Crypto.Crypto,
      };
    }).pipe(Effect.provide(adapterLayer));
    return {
      instanceId: input.instanceId,
      settings,
      modelCatalog: { models: [] },
      attachmentsDir: input.attachmentsDir,
      path: dependencies.path,
      idAllocator: dependencies.idAllocator,
      crypto: dependencies.crypto,
      fileSystem: fileSystem(input.files),
      host: {
        cwd: () => "/workspace",
        taskOutputRoot: () => undefined,
        resolveAttachmentPath: ({ attachmentsDir, attachment }) =>
          `${attachmentsDir}/${attachment.id}`,
        discoverSkills: () => Effect.succeed([]),
        readWorkflowAgentAnswers: () => Effect.succeed([]),
        signedOutMessage: () => "The qualification fixture has no provider account.",
      },
    } satisfies ClaudeAdapter;
  });
}
