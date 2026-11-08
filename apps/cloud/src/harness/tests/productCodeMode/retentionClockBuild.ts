// @effect-diagnostics nodeBuiltinImport:off - Native fixture bundling controls only the session store's clock.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Plugin } from "esbuild";

export function retentionClockPlugin(): Plugin {
  const source = NodeURL.fileURLToPath(
    new URL("../../../kernel/CodexExecSessions.ts", import.meta.url),
  );
  const clock = JSON.stringify(
    NodeURL.fileURLToPath(new URL("./retentionClock.ts", import.meta.url)),
  );
  return {
    name: "controlled-exec-retention",
    setup(build) {
      build.onResolve({ filter: /CodexExecSessions\.ts$/ }, () => ({
        path: "sessions",
        namespace: "retention-wrapper",
      }));
      build.onResolve({ filter: /^retention-original$/ }, () => ({
        path: source,
        namespace: "retention-original",
      }));
      build.onLoad({ filter: /.*/, namespace: "retention-wrapper" }, () => ({
        contents: `import {CodexExecSessions as Original} from "retention-original";
import {retentionClock} from ${clock};
export * from "retention-original";
export class CodexExecSessions extends Original {
  constructor(options) { super({...options, detachedTtlMs: retentionClock.ttlMs}); }
}`,
        loader: "ts",
        resolveDir: NodePath.dirname(source),
      }));
      // Lexical clock imports leave the native engine and the rest of the host on real WASI timers.
      build.onLoad({ filter: /.*/, namespace: "retention-original" }, async () => ({
        contents: `import {retentionDate as Date, retentionSetTimeout as setTimeout, retentionClearTimeout as clearTimeout} from ${clock};\n${await NodeFSP.readFile(source, "utf8")}`,
        loader: "ts",
        resolveDir: NodePath.dirname(source),
      }));
    },
  };
}
