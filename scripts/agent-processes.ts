#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - cleanup works even when node_modules has been removed.
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import {
  reap,
  status,
  stop,
  resolveCommonDir,
} from "../packages/shared/src/agentProcesses/registry.ts";
import { recordSession, sessions } from "../packages/shared/src/agentProcessSessions.ts";
import { resolveProcessWorktree } from "./lib/agent-process-worktree.ts";
import { runTrackedCommand } from "./lib/agent-process-run.ts";

async function harnessHook() {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const payload: unknown = JSON.parse(input);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("session_id" in payload) ||
    typeof payload.session_id !== "string" ||
    !("cwd" in payload) ||
    typeof payload.cwd !== "string" ||
    !("hook_event_name" in payload) ||
    typeof payload.hook_event_name !== "string"
  ) {
    throw new Error("Expected harness session_id, cwd and hook_event_name");
  }
  const worktreePath = await resolveProcessWorktree(payload.cwd);
  const sessionId =
    "agent_id" in payload && typeof payload.agent_id === "string"
      ? `${payload.session_id}/${payload.agent_id}`
      : payload.session_id;
  const shellValue = `'${sessionId.replaceAll("'", `'"'"'`)}'`;
  if (payload.hook_event_name === "SessionStart" || payload.hook_event_name === "SubagentStart") {
    await recordSession(worktreePath, sessionId, false);
    const environmentFile = process.env.CLAUDE_ENV_FILE;
    if (payload.hook_event_name === "SessionStart" && environmentFile !== undefined) {
      await NodeFSP.appendFile(
        environmentFile,
        `\nexport SIGNALBOX_PROCESS_SESSION_ID=${shellValue}\n`,
      );
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: payload.hook_event_name,
          additionalContext: `For background commands, use node scripts/agent-processes.ts run --session-id ${shellValue} -- <command>. Stop owned commands before reporting done.`,
        },
      }),
    );
  } else if (
    payload.hook_event_name === "SessionEnd" ||
    payload.hook_event_name === "SubagentStop"
  ) {
    // The marker survives the harness's short hook timeout, so the reaper can finish.
    await recordSession(worktreePath, sessionId, true);
    await stop(worktreePath, { sessionId, graceMs: 250 });
  } else {
    throw new Error("Unsupported process cleanup hook event");
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "hook") return harnessHook();
  const separator = args.indexOf("--");
  const options = NodeUtil.parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    options: {
      worktree: { type: "string" },
      "session-id": { type: "string" },
      all: { type: "boolean" },
    },
  });
  const worktreePath = await resolveProcessWorktree(options.values.worktree ?? process.cwd());
  if (command === "run") {
    const [executable, ...commandArgs] = separator < 0 ? [] : args.slice(separator + 1);
    if (executable === undefined)
      throw new Error("Usage: agent-processes run [--session-id ID] -- <command> [args]");
    process.exitCode = await runTrackedCommand({
      command: executable,
      args: commandArgs,
      worktreePath,
      cwd: options.values.worktree ?? process.cwd(),
      sessionId: options.values["session-id"],
    });
    return;
  }
  if (command === "stop") {
    const sessionId = options.values["session-id"];
    const result = await stop(worktreePath, sessionId === undefined ? {} : { sessionId });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const commonDir = resolveCommonDir(worktreePath);
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(await status(options.values.all ? { commonDir } : { worktreePath }), null, 2)}\n`,
    );
    return;
  }
  if (command === "reap") {
    const isSessionEnded = async (sessionId: string, worktreePath: string) =>
      (await sessions(worktreePath)).some(
        (session) => session.sessionId === sessionId && session.ended,
      );
    process.stdout.write(`${JSON.stringify(await reap({ commonDir, isSessionEnded }), null, 2)}\n`);
    return;
  }
  throw new Error(
    "Usage: agent-processes <run|stop|reap|status|hook> [--worktree PATH] [--session-id ID] [--all]",
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(`agent-processes: ${String(error)}\n`);
  process.exitCode = 1;
});
