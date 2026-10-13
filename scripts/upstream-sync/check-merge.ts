// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI script, run by signalbox-ci.yml.
/**
 * Fails when a branch stops merging cleanly with upstream T3 Code.
 *
 *   node scripts/upstream-sync/check-merge.ts --base <ref> --head <ref> --upstream <ref> [--report]
 *
 * Only conflicts the head introduces count: files that conflict for head but
 * not for base. `--report` prints conflicts and always exits 0.
 */
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { introducedConflicts } from "./mergeTree.ts";

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      upstream: { type: "string", default: "upstream/main" },
      report: { type: "boolean", default: false },
    },
  });
  if (!values.base) throw new Error("--base is required");
  const cwd = NodePath.resolve(import.meta.dirname, "../..");
  const { introduced, preexisting } = introducedConflicts(cwd, {
    base: values.base,
    head: values.head,
    upstream: values.upstream,
  });

  if (preexisting.length > 0) {
    console.log(`Already conflicting on ${values.base}, left to the upstream sync:`);
    for (const file of preexisting) console.log(`  ${file}`);
  }
  if (introduced.length === 0) {
    console.log(`${values.head} adds no conflicts with ${values.upstream}.`);
    return;
  }
  console.log(`${values.head} no longer merges cleanly with ${values.upstream}:`);
  for (const file of introduced) {
    console.log(`  ${file}`);
    if (!values.report) console.log(`::error file=${file}::Conflicts with ${values.upstream}`);
  }
  console.log(
    "Keep fork changes out of upstream files where you can. See docs/operations/upstream-sync.md.",
  );
  if (!values.report) process.exitCode = 1;
}

if (import.meta.main) main();
