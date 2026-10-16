// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI script, run by signalbox-ci.yml.
/**
 * On a pull request that merges upstream T3 Code, fails when a fork hook line
 * on the base is gone from the head, unless upstream deleted its file. Other
 * pull requests may drop hooks.
 *
 *   node scripts/upstream-sync/check-hooks.ts --base <ref> --head <ref> [--upstream <ref>]
 *
 * Writes `sync=true|false` to $GITHUB_OUTPUT: whether the head merges upstream.
 * The `Upstream Sync` check runs only when it does and this passed, which is
 * what a folder's Merge gate trusts (#5).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { deletedUpstream, droppedHooks, hookChanges, mergesUpstream } from "./hooks.ts";

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      upstream: { type: "string", default: "upstream/main" },
    },
  });
  if (!values.base) throw new Error("--base is required");
  const cwd = NodePath.resolve(import.meta.dirname, "../..");
  const refs = { base: values.base, head: values.head, upstream: values.upstream };
  const sync = mergesUpstream(cwd, refs);
  if (process.env.GITHUB_OUTPUT) NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `sync=${sync}\n`);
  if (!sync) {
    console.log(`${refs.head} doesn't merge new ${refs.upstream} commits; hooks aren't checked.`);
    return;
  }

  const { removed, added } = hookChanges(cwd, refs);
  const deleted = deletedUpstream(cwd, refs);
  const missing = droppedHooks(removed, added);
  for (const hook of missing.filter((hook) => deleted.has(hook.file))) {
    console.log(`Upstream deleted ${hook.file}, and its hook with it: signalbox: ${hook.text}`);
    console.log(
      `::notice file=${hook.file}::Upstream deleted this file and hook "signalbox: ${hook.text}"`,
    );
  }
  const dropped = missing.filter((hook) => !deleted.has(hook.file));
  if (dropped.length === 0) {
    console.log(`${refs.head} merges ${refs.upstream} and keeps every signalbox: hook line.`);
    return;
  }
  console.log(`${refs.head} merges ${refs.upstream} but drops ${dropped.length} hook line(s):`);
  for (const hook of dropped) {
    console.log(`  ${hook.file}: signalbox: ${hook.text}`);
    console.log(`::error file=${hook.file}::Upstream merge dropped hook "signalbox: ${hook.text}"`);
  }
  console.log(
    "Re-apply each hook to upstream's new code. See docs/operations/upstream-sync.md, step 2.",
  );
  process.exitCode = 1;
}

if (import.meta.main) main();
