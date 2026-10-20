import { ClaudeSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { ClaudeIsolateAdapterOptions } from "../../ClaudeIsolateAdapter.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import { data } from "../../adapter/tests/data.ts";
import { fixture } from "./fixture.ts";

const decodeSettings = Schema.decodeEffect(ClaudeSettings);

export function readinessFixture() {
  const f = fixture();
  const fs = createNodeFs(f.files).fs;
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
  const fileSystem = FileSystem.makeNoop({
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
  const crypto = Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, bytes) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, bytes.slice())),
        catch: (cause) =>
          PlatformError.systemError({ _tag: "Unknown", module: "Crypto", method: "digest", cause }),
      }),
  });
  const services = Effect.gen(function* () {
    const seed = yield* data;
    const instanceId = ProviderInstanceId.make("claude-readiness-test");
    const driver = ProviderDriverKind.make("claudeAgent");
    const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
    const providerThread = { ...seed.turn.providerThread, driver, providerInstanceId: instanceId };
    const turn = {
      ...seed.turn,
      providerThread,
      modelSelection,
      appThread: { ...seed.turn.appThread, providerInstanceId: instanceId, modelSelection },
    };
    const adapter: ClaudeIsolateAdapterOptions["adapter"] = {
      instanceId,
      settings: yield* decodeSettings({ binaryPath: "/runtime/claude" }),
      modelCatalog: { models: [] },
      attachmentsDir: "/work/attachments",
      fileSystem,
      crypto,
      path: yield* Path.Path,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      host: {
        cwd: () => "/work",
        taskOutputRoot: () => undefined,
        resolveAttachmentPath: ({ attachmentsDir, attachment }) =>
          `${attachmentsDir}/${attachment.id}`,
        discoverSkills: () => Effect.succeed([]),
        readWorkflowAgentAnswers: () => Effect.succeed([]),
        signedOutMessage: () => "Test provider is signed out",
      },
    };
    return {
      adapter,
      computer: { ...f.input.computer, threadId: seed.threadId },
      mcpSessions: yield* McpProviderSessions.McpProviderSessions,
      session: {
        threadId: seed.threadId,
        providerSessionId: seed.providerSessionId,
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: "/work",
        },
      },
      turn,
    };
  }).pipe(Effect.provide(Layer.mergeAll(Path.layer, IdAllocator.layer, McpProviderSessions.layer)));
  return { ...f, services };
}
