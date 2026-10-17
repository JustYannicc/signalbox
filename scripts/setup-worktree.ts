// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);

// `shell` resolves `vp` through PATH, including Windows command shims.
// Setup has no one answering install prompts. Pass pnpm's confirmation flag
// through vp and leave stdin closed so other prompts fail instead of hanging.
// Install exactly the locked dependencies so setup never rewrites the lockfile.
// A stale lockfile must fail setup rather than silently resolving a new one.
const install = NodeChildProcess.spawnSync("vp i --frozen-lockfile -- --yes", {
  cwd: worktree,
  shell: true,
  stdio: ["ignore", "inherit", "inherit"],
});
if (install.status !== 0) process.exit(install.status ?? 1);

// pnpm 11 can reuse an interrupted patch-only slot without finishing its patch.
// This checks the Apple patch where we reproduced it, only while that version is installed.
const transcriptionPackage = NodePath.join(
  worktree,
  "apps/mobile/node_modules/@react-native-ai/apple/package.json",
);
const checkTranscriptionPatch =
  NodeFS.existsSync(NodePath.join(worktree, "patches/@react-native-ai__apple@0.12.0.patch")) &&
  NodeFS.existsSync(transcriptionPackage) &&
  JSON.parse(NodeFS.readFileSync(transcriptionPackage, "utf8")).version === "0.12.0";
const transcriptionSpec = NodePath.join(
  worktree,
  "apps/mobile/node_modules/@react-native-ai/apple/src/NativeAppleTranscription.ts",
);
const hasTranscriptionPatch = () =>
  NodeFS.existsSync(transcriptionSpec) &&
  NodeFS.readFileSync(transcriptionSpec, "utf8").includes(
    "prepare(language: string): Promise<string>",
  );
if (checkTranscriptionPatch && !hasTranscriptionPatch()) {
  const repair = NodeChildProcess.spawnSync("vp i --frozen-lockfile --force -- --yes", {
    cwd: worktree,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (repair.status !== 0) process.exit(repair.status ?? 1);
  if (!hasTranscriptionPatch())
    throw new Error("pnpm did not finish the Apple transcription patch.");
}

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
