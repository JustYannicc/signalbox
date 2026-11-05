import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { createThreadClaudeSessions } from "../ThreadClaudeSessions.ts";
import { captureClaudeTranscriptFiles } from "../../harness/ClaudeTranscriptFiles.ts";
import * as SessionRows from "../ThreadSessionRows.ts";
import { facetSqlite } from "./facetSqlite.ts";

const driver = ProviderDriverKind.make("claudeAgent");
export const thread = {
  driver,
  nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" as const },
};
export const main = "/home/.claude/projects/-workspace/native-session.jsonl";
export const first = '{"type":"user","uuid":"one","message":{"content":"real transcript"}}';
export const second = '{"type":"assistant","uuid":"two","message":{"content":"done"}}';
export const layer = SessionRows.layer.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

export const fixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(Effect.sync(facetSqlite), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => files.dispose()));
  const fs = createNodeFs(files).fs;
  fs.mkdirSync("/home/.claude/projects/-workspace/native-session/subagents", { recursive: true });
  fs.writeFileSync(main, `${first}\n`);
  const persistence = yield* createThreadClaudeSessions({
    capture: (nativeId, signal) =>
      captureClaudeTranscriptFiles(files, "/home/.claude", nativeId, signal),
  });
  return { files, fs, persistence, sessions: yield* SessionRows.SessionRows };
});
