import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { forkParked } from "../../serverActivation.ts";
import { findPackageRunner } from "../packageRunner.ts";
import { SKILL_NAME, skillFiles } from "./files.ts";

/**
 * Makes the built-in automations skill available to every harness Signalbox
 * runs, through skills.sh: the files are written under the server's state
 * dir and installed globally for each provider's agent. Installs only when
 * the content changed, so restarts are free; dev servers only write the files. Without a skills CLI runner the
 * agents still get the always-on instructions and `automation_reference`.
 */

const SKILLS_CLI = "skills@1.7.0";
/** skills.sh agent ids for the harnesses Signalbox drives. */
const AGENTS = ["claude-code", "codex", "cursor", "opencode", "pi", "grok", "antigravity"];
const INSTALL_TIMEOUT = "3 minutes";

/** `skills add <dir> -g -a … -y --copy`: global, for Signalbox's harnesses only, no prompts. */
export function skillsAddArgs(directory: string) {
  return [
    "add",
    directory,
    "--global",
    ...AGENTS.flatMap((agent) => ["--agent", agent]),
    "--yes",
    "--copy",
    "--json",
  ];
}

/** The first package runner found: npx beside Node, then npx, pnpm dlx, bunx on PATH. */
const findRunner = findPackageRunner([
  { name: "npx", besideNode: true, args: ["--yes", SKILLS_CLI] },
  { name: "npx", args: ["--yes", SKILLS_CLI] },
  { name: "pnpm", args: ["dlx", SKILLS_CLI] },
  { name: "bunx", args: [SKILLS_CLI] },
]);

const install = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const processes = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcessEnvironment;

  const files = skillFiles();
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(
      Object.entries(files)
        .map(([file, text]) => `${file}\n${text}`)
        .join("\n\0"),
    ),
  );
  const hash = Hex.encode(digest);
  const root = path.join(config.stateDir, "skills");
  const directory = path.join(root, SKILL_NAME);
  const marker = path.join(root, `${SKILL_NAME}.installed`);
  const installed = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
  if (installed.trim() === hash) return;

  yield* fs.remove(directory, { recursive: true, force: true });
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(directory, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, text);
  }

  // A dev server's skill may be a branch's draft; it must never replace the one installed for real use.
  if (config.devUrl !== undefined) return;
  const runner = yield* findRunner;
  if (Option.isNone(runner)) {
    yield* Effect.logWarning(
      "No npx, pnpm or bunx found; the automations skill isn't installed for agents.",
    );
    return;
  }
  const result = yield* processes.run({
    command: runner.value.command,
    args: [...runner.value.args, ...skillsAddArgs(directory)],
    cwd: root,
    env: { ...environment, DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1" },
    timeout: INSTALL_TIMEOUT,
    outputMode: "truncate",
  });
  if (result.code !== 0) {
    yield* Effect.logWarning("Installing the automations skill failed", {
      stderr: result.stderr.slice(-2000),
    });
    return;
  }
  yield* fs.writeFileString(marker, hash);
  yield* Effect.logInfo("Installed the automations skill for agents", { directory });
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Installing the automations skill failed", { cause }),
  ),
);

export const layer = Layer.effectDiscard(forkParked(install)).pipe(
  Layer.provide(ProcessRunner.layer),
);
