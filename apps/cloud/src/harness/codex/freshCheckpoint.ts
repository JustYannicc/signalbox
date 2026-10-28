import type { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import type { CodexAppServerSessionClient } from "@signalbox/provider-codex/clientFactory";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import type { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";

const nativeThread = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    ephemeral: Schema.Literal(false),
  }),
);
const sessionMeta = Schema.is(
  Schema.Struct({
    type: Schema.Literal("session_meta"),
    payload: Schema.Struct({ id: Schema.String }),
  }),
);
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

export const materializeFreshCodexCheckpoint = (input: {
  readonly runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">;
  readonly client: Pick<CodexAppServerSessionClient["raw"], "request">;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly threadId: ThreadId;
  readonly files: KernelFileSystem;
  readonly codexHome: string;
}) => {
  const error = (cause: unknown) =>
    new ProviderAdapter.ProviderAdapterEnsureThreadError({
      driver: input.providerThread.driver,
      threadId: input.threadId,
      cause,
    });
  return Effect.gen(function* () {
    const nativeId = input.providerThread.nativeThreadRef?.nativeId;
    const read = () =>
      input.runtime.readThreadSnapshot({ providerThread: input.providerThread }).pipe(
        Effect.flatMap((snapshot) =>
          Effect.try({
            try: () => {
              const thread = nativeThread(snapshot.providerPayload);
              if (
                !nativeId ||
                thread.id !== nativeId ||
                !thread.path.startsWith(`${input.codexHome}/sessions/`)
              )
                throw new Error("Fresh Codex checkpoint has a different native identity or path.");
              return thread;
            },
            catch: error,
          }),
        ),
      );
    const fs = createNodeFs(input.files).fs;
    let thread = yield* read();
    const exists = yield* Effect.try({
      try: () => {
        try {
          fs.statSync(thread.path);
          return true;
        } catch (cause) {
          if (missing(cause)) return false;
          throw cause;
        }
      },
      catch: error,
    });
    if (!exists) {
      // Codex defers a fresh rollout until input. Its archive/unarchive pair persists it
      // without turns, before this UUID is published or accepts any user input.
      yield* input.client.request("thread/archive", { threadId: nativeId });
      yield* input.client.request("thread/unarchive", { threadId: nativeId });
      thread = yield* read();
    }
    yield* Effect.try({
      try: () => {
        const path = fs.realpathSync(thread.path);
        if (typeof path !== "string" || !path.startsWith(`${input.codexHome}/sessions/`))
          throw new Error("Fresh Codex rollout resolves outside its session home.");
        const bytes = fs.readFileSync(path);
        if (typeof bytes === "string")
          throw new Error("Fresh Codex rollout bytes are unavailable.");
        const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!contents.endsWith("\n")) throw new Error("Fresh Codex rollout is incomplete.");
        const rows: unknown[] = contents
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (!sessionMeta(rows[0]) || rows[0].payload.id !== nativeId)
          throw new Error("Fresh Codex rollout belongs to another native thread.");
      },
      catch: error,
    });
  }).pipe(Effect.mapError(error));
};
