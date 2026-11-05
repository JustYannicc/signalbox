import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { layerCrypto } from "../../../../src/platform.ts";
import type { ClaudeNativeHostBindingOptions } from "../../../../src/harness/ClaudeNativeHostBinding.ts";
import { HarnessError } from "../../../../src/harness/Harness.ts";
type ClaudeAdapter = ClaudeNativeHostBindingOptions["adapter"];
const adapterLayer = Layer.mergeAll(Path.layer, IdAllocator.layer, layerCrypto);
const decodeSettings = Schema.decodeUnknownSync(ClaudeSettings);

/** Uses the real Claude adapter and Computer filesystem while keeping tools authority injected. */
export function buildClaudeSdkAdapter(input: {
  readonly fileSystem: FileSystem.FileSystem;
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
      fileSystem: input.fileSystem,
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
