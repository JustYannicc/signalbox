// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Host-side fixture that seeds an isolated demo T3 home.
/**
 * Fork-owned demo environment: an isolated T3 home filled with fabricated
 * projects and threads, so the prototype never shows real work.
 *
 *   node scripts/demo-environment.ts [--reset] [--home-dir <path>]
 *   node scripts/demo-environment.ts --mark-running   # after the dev server boots
 *
 * Migrations run through the server's offline CLI (no server start), then the
 * projection tables are written directly, like `mobile-showcase-environment.ts`.
 * The event log is emptied, so the projections are the whole state.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  DEMO_PROJECTS,
  DEMO_THREADS,
  type DemoProject,
  type DemoThread,
} from "./lib/demo-dataset.ts";
import {
  demoPaths,
  markRunning,
  seedDatabase,
  type DemoCheckpointRecord,
} from "./lib/demo-database.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
export const DEFAULT_DEMO_HOME = NodePath.join(REPO_ROOT, ".t3", "demo-home");

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Demo User",
  GIT_AUTHOR_EMAIL: "demo@t3.invalid",
  GIT_COMMITTER_NAME: "Demo User",
  GIT_COMMITTER_EMAIL: "demo@t3.invalid",
};

async function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { stdout } = await execFile("git", [...args], {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY, ...env },
  });
  return stdout.trim();
}

async function gitSucceeds(cwd: string, args: ReadonlyArray<string>): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function remoteUrl(project: DemoProject): string | null {
  return project.remote ? `https://${project.remote.host}/${project.remote.repository}.git` : null;
}

/** Creates the fake repo once, then any branch or worktree a thread needs that is missing. */
async function ensureRepository(home: string, project: DemoProject): Promise<void> {
  const paths = demoPaths(home);
  const root = paths.repoRoot(project);
  if (!NodeFS.existsSync(root)) {
    for (const [file, content] of Object.entries(project.files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, file), content);
    }
    // Every project gets its own repo, even the no-code one: the demo home sits
    // inside this checkout, so a plain folder would resolve to its git repo.
    await git(root, ["init", "-q", "-b", "main"]);
    const url = remoteUrl(project);
    if (url) await git(root, ["remote", "add", "origin", url]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", `Initial ${project.title}`]);
  }
  for (const thread of DEMO_THREADS) {
    if (thread.projectId !== project.id || !thread.branch) continue;
    if (!thread.worktree) {
      if (
        !(await gitSucceeds(root, ["rev-parse", "--verify", "-q", `refs/heads/${thread.branch}`]))
      ) {
        await git(root, ["branch", thread.branch]);
      }
      continue;
    }
    const worktree = paths.worktree(thread);
    if (NodeFS.existsSync(worktree)) continue;
    await NodeFSP.mkdir(NodePath.dirname(worktree), { recursive: true });
    const branchExists = await gitSucceeds(root, [
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${thread.branch}`,
    ]);
    await git(
      root,
      branchExists
        ? ["worktree", "add", "-q", worktree, thread.branch]
        : ["worktree", "add", "-q", "-b", thread.branch, worktree],
    );
    // An uncommitted edit gives the diff and pipeline views something to show.
    await NodeFSP.writeFile(
      NodePath.join(worktree, "NOTES.md"),
      `# ${thread.title}\n\n- [x] Reproduce\n- [ ] Verify the fix\n`,
    );
  }
}

/**
 * Captures real checkpoint refs the way the server does (a commit of the
 * whole working tree under refs/t3/checkpoints/<thread>/turn/<n>), so the
 * Diff panel's turn and thread diffs resolve. Fixed dates keep reseeds
 * idempotent; the working tree ends at the latest turn's files, uncommitted.
 */
async function captureCheckpoints(
  home: string,
  thread: DemoThread,
): Promise<ReadonlyArray<DemoCheckpointRecord | null>> {
  const project = DEMO_PROJECTS.find((candidate) => candidate.id === thread.projectId);
  if (!project || !thread.checkpoints) return [];
  const paths = demoPaths(home);
  const cwd = thread.worktree ? paths.worktree(thread) : paths.repoRoot(project);
  const touched = [...new Set(thread.checkpoints.flatMap((files) => Object.keys(files)))];
  // Put touched files back to HEAD so every reseed replays the same turns.
  for (const file of touched) {
    if (await gitSucceeds(cwd, ["cat-file", "-e", `HEAD:${file}`])) {
      await git(cwd, ["checkout", "HEAD", "--", file]);
    } else {
      await NodeFSP.rm(NodePath.join(cwd, file), { force: true });
    }
  }
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-demo-checkpoint-"));
  const env = {
    GIT_INDEX_FILE: NodePath.join(tempDir, "index"),
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const refFor = (turnCount: number) =>
    `refs/t3/checkpoints/${Buffer.from(thread.id).toString("base64url")}/turn/${turnCount}`;
  const snapshot = async (parent: string, turnCount: number): Promise<string> => {
    await git(cwd, ["add", "-A", "."], env);
    const tree = await git(cwd, ["write-tree"], env);
    const commit = await git(
      cwd,
      ["commit-tree", tree, "-p", parent, "-m", `t3 checkpoint turn ${turnCount}`],
      env,
    );
    await git(cwd, ["update-ref", refFor(turnCount), commit]);
    return commit;
  };
  try {
    let previous = await snapshot(await git(cwd, ["rev-parse", "HEAD"]), 0);
    const completedTurns =
      thread.state === "running" ? thread.exchanges.length - 1 : thread.exchanges.length;
    const records: Array<DemoCheckpointRecord | null> = [];
    for (let index = 0; index < completedTurns; index += 1) {
      for (const [file, content] of Object.entries(thread.checkpoints[index] ?? {})) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(cwd, file), content);
      }
      const commit = await snapshot(previous, index + 1);
      const numstat = await git(cwd, ["diff", "--numstat", previous, commit]);
      records.push({
        turnCount: index + 1,
        ref: refFor(index + 1),
        files: numstat
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [additions = "0", deletions = "0", file = ""] = line.split("\t");
            return {
              path: file,
              kind: "modified" as const,
              additions: Number(additions) || 0,
              deletions: Number(deletions) || 0,
            };
          }),
      });
      previous = commit;
    }
    return records;
  } finally {
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

/** Runs the server's migrations offline: auth commands open the state DB without serving. */
async function migrate(home: string): Promise<void> {
  await execFile(
    process.execPath,
    ["apps/server/src/bin.ts", "auth", "pairing", "list", "--base-dir", home, "--json"],
    { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: "1" } },
  );
}

function assertNoLiveServer(home: string): void {
  const { runtimeStatePath } = demoPaths(home);
  if (!NodeFS.existsSync(runtimeStatePath)) return;
  const { pid } = JSON.parse(NodeFS.readFileSync(runtimeStatePath, "utf8")) as { pid?: number };
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  throw new Error(`A server (pid ${pid}) is using ${home}. Stop it before reseeding.`);
}

export async function createDemoEnvironment(input: {
  readonly home: string;
  readonly reset: boolean;
  readonly now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  assertNoLiveServer(input.home);
  if (input.reset) await NodeFSP.rm(input.home, { recursive: true, force: true });
  for (const project of DEMO_PROJECTS) await ensureRepository(input.home, project);
  const checkpoints = new Map<string, ReadonlyArray<DemoCheckpointRecord | null>>();
  for (const thread of DEMO_THREADS) {
    if (thread.checkpoints)
      checkpoints.set(thread.id, await captureCheckpoints(input.home, thread));
  }
  await migrate(input.home);
  seedDatabase(input.home, now, checkpoints);
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      reset: { type: "boolean", default: false },
      "mark-running": { type: "boolean", default: false },
      "home-dir": { type: "string", default: DEFAULT_DEMO_HOME },
    },
  });
  const home = NodePath.resolve(values["home-dir"]);
  if (values["mark-running"]) {
    console.log(
      `Marked ${markRunning(home, Date.now())} demo threads as running. Reload the client.`,
    );
  } else {
    await createDemoEnvironment({ home, reset: values.reset });
    const isDefaultHome = home === DEFAULT_DEMO_HOME;
    const homeFlag = isDefaultHome ? "" : ` --home-dir ${home}`;
    console.log(
      [
        `Demo environment ready: ${DEMO_PROJECTS.length} projects, ${DEMO_THREADS.length} threads in ${home}`,
        "",
        "Start the dev server against it:",
        isDefaultHome
          ? "  node_modules/.bin/vp run dev:demo"
          : `  node_modules/.bin/vp run dev --home-dir ${home} --no-auto-bootstrap-project-from-cwd`,
        "",
        "Once it has booted, restore the running threads (boot orphans them) and reload:",
        `  node scripts/demo-environment.ts --mark-running${homeFlag}`,
      ].join("\n"),
    );
  }
}
