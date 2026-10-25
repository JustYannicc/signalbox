// @effect-diagnostics nodeBuiltinImport:off - snapshots checkout manifests for compiler comparisons.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const workspaceParents = ["apps", "packages", "infra"] as const;

export interface WorkspaceManifest {
  relativePath: string;
  absolutePath: string;
  originalBytes: Buffer;
  typecheckScript: string | undefined;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}

function manifest(bytes: Buffer | string, file: string) {
  const value: unknown = JSON.parse(bytes.toString());
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${file}: package.json must contain an object`);
  return value as Record<string, unknown>;
}

function typecheckScript(value: Record<string, unknown>, file: string) {
  const scripts = value.scripts;
  if (scripts === undefined) return undefined;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))
    throw new Error(`${file}: scripts must be an object`);
  const script = Reflect.get(scripts, "typecheck");
  if (script === undefined) return undefined;
  if (typeof script !== "string") throw new Error(`${file}: scripts.typecheck must be a string`);
  return script;
}

function isRegularFile(path: string) {
  try {
    const stat = NodeFS.lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export function discoverWorkspaces(rootDirectory: string): WorkspaceManifest[] {
  const paths: string[] = [];
  for (const parent of workspaceParents) {
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(NodePath.join(rootDirectory, parent), { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = `${parent}/${entry.name}/package.json`;
      if (isRegularFile(NodePath.join(rootDirectory, path))) paths.push(path);
    }
  }
  for (const directory of ["scripts", "oxlint-plugin-t3code"]) {
    const path = `${directory}/package.json`;
    if (isRegularFile(NodePath.join(rootDirectory, path))) paths.push(path);
  }

  return paths.sort().map((relativePath) => {
    const absolutePath = NodePath.join(rootDirectory, relativePath);
    const originalBytes = NodeFS.readFileSync(absolutePath);
    return {
      relativePath,
      absolutePath,
      originalBytes,
      typecheckScript: typecheckScript(manifest(originalBytes, relativePath), relativePath),
    };
  });
}

export function planBaselineTypecheckScripts(
  current: readonly Pick<WorkspaceManifest, "relativePath" | "typecheckScript">[],
  baselineScripts: ReadonlyMap<string, string | undefined>,
  baselineWorkspacePaths: ReadonlySet<string>,
  effectCompilerPath: string,
) {
  const currentPaths = new Set(current.map(({ relativePath }) => relativePath));
  const overrides = new Map<string, string | undefined>();
  const compilerMappings: {
    workspace: string;
    originalScript: string;
    effectiveScript: string;
    commandCount: number;
  }[] = [];
  const notes = {
    newWorkspaces: [] as string[],
    baselineWithoutTypecheck: [] as string[],
    baselineOnlyTypecheck: [] as string[],
    currentOnlyTypecheck: [] as string[],
    baselineOnlyWorkspaces: [...baselineWorkspacePaths].filter((path) => !currentPaths.has(path)),
  };
  for (const workspace of current) {
    const path = workspace.relativePath;
    if (!baselineWorkspacePaths.has(path)) {
      notes.newWorkspaces.push(path);
      continue;
    }
    const baselineScript = baselineScripts.get(path);
    const mapped =
      baselineScript === undefined
        ? { script: undefined, commandCount: 0 }
        : mapBaselineTscCommands(baselineScript, effectCompilerPath);
    overrides.set(path, mapped.script);
    if (baselineScript === undefined) notes.baselineWithoutTypecheck.push(path);
    if (baselineScript !== undefined && workspace.typecheckScript === undefined)
      notes.baselineOnlyTypecheck.push(path);
    if (baselineScript === undefined && workspace.typecheckScript !== undefined)
      notes.currentOnlyTypecheck.push(path);
    if (baselineScript !== undefined && mapped.commandCount > 0)
      compilerMappings.push({
        workspace: path,
        originalScript: baselineScript,
        effectiveScript: mapped.script!,
        commandCount: mapped.commandCount,
      });
  }
  for (const value of Object.values(notes)) value.sort();
  return { overrides, notes, compilerMappings };
}

export function mapBaselineTscCommands(script: string, effectCompilerPath: string) {
  if (!NodePath.isAbsolute(effectCompilerPath))
    throw new Error("Effect compiler path must be absolute");
  const quotedCompiler = `'${effectCompilerPath.replaceAll("'", "'\\''")}'`;
  let commandCount = 0;
  const mappedScript = script.replace(
    /(^\s*|(?:&&|\|\||[;&|])\s*)tsc(?=\s|$)/gm,
    (_match, prefix: string) => {
      commandCount++;
      return `${prefix}${quotedCompiler}`;
    },
  );
  return { script: mappedScript, commandCount };
}

function assertOwnedManifest(rootDirectory: string, workspace: WorkspaceManifest) {
  const absolutePath = NodePath.resolve(rootDirectory, workspace.relativePath);
  const relativePath = NodePath.relative(rootDirectory, absolutePath);
  const checkout = NodeFS.realpathSync(rootDirectory);
  const actual = NodeFS.realpathSync(absolutePath);
  if (
    relativePath.startsWith("..") ||
    NodePath.isAbsolute(relativePath) ||
    (actual !== checkout && !actual.startsWith(`${checkout}${NodePath.sep}`))
  )
    throw new Error(`Refusing to edit a manifest outside the checkout: ${workspace.relativePath}`);
  if (!isRegularFile(absolutePath))
    throw new Error(`Refusing to edit a non-regular workspace manifest: ${workspace.relativePath}`);
}

function setTypecheck(value: Record<string, unknown>, script: string | undefined) {
  const scripts = value.scripts ?? {};
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))
    throw new Error("package.json scripts must be an object");
  if (script === undefined) Reflect.deleteProperty(scripts, "typecheck");
  else Reflect.set(scripts, "typecheck", script);
  value.scripts = scripts;
}

export async function withTemporaryTypecheckScripts<T>(
  rootDirectory: string,
  workspaces: readonly WorkspaceManifest[],
  overrides: ReadonlyMap<string, string | undefined>,
  action: () => Promise<T>,
): Promise<T> {
  const byPath = new Map(workspaces.map((workspace) => [workspace.relativePath, workspace]));
  const snapshots = [...overrides]
    .map(([path]) => {
      const workspace = byPath.get(path);
      if (!workspace) throw new Error(`No checkout workspace for baseline manifest ${path}`);
      assertOwnedManifest(rootDirectory, workspace);
      const bytes = NodeFS.readFileSync(workspace.absolutePath);
      if (!bytes.equals(workspace.originalBytes))
        throw new Error(`Workspace manifest changed before benchmark: ${path}`);
      return { workspace, bytes };
    })
    .filter(({ workspace }) => overrides.get(workspace.relativePath) !== workspace.typecheckScript);

  let result!: T;
  let failure: unknown;
  let failed = false;
  try {
    for (const { workspace, bytes } of snapshots) {
      const value = manifest(bytes, workspace.relativePath);
      setTypecheck(value, overrides.get(workspace.relativePath));
      NodeFS.writeFileSync(workspace.absolutePath, `${JSON.stringify(value, null, 2)}\n`);
    }
    result = await action();
  } catch (error) {
    failed = true;
    failure = error;
  }

  const restoreErrors: unknown[] = [];
  for (const { workspace, bytes } of snapshots) {
    try {
      assertOwnedManifest(rootDirectory, workspace);
      NodeFS.writeFileSync(workspace.absolutePath, bytes);
    } catch (error) {
      restoreErrors.push(error);
    }
  }
  if (restoreErrors.length) {
    if (failed) restoreErrors.unshift(failure);
    throw new AggregateError(restoreErrors, "Workspace manifest restoration failed");
  }
  if (failed) throw failure;
  return result;
}

function gitOutput(root: string, args: string[]) {
  return NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
}

export function resolveBaselineCommit(root: string, reference: string) {
  if (!reference || reference.startsWith("-")) throw new Error("Pass a baseline Git ref");
  return gitOutput(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${reference}^{commit}`,
  ]).trim();
}

export function loadBaselineScripts(
  root: string,
  commit: string,
  workspaces: readonly WorkspaceManifest[],
) {
  // List directory entries before selecting manifests; vendored trees can exceed Git's output buffer.
  const parents = gitOutput(root, [
    "ls-tree",
    "-d",
    "--name-only",
    commit,
    "--",
    ...workspaceParents,
  ])
    .split("\n")
    .filter(Boolean);
  const manifests = ["scripts/package.json", "oxlint-plugin-t3code/package.json"];
  for (const parent of parents) {
    const children = gitOutput(root, ["ls-tree", "-d", "--name-only", `${commit}:${parent}`]);
    for (const directory of children.split("\n").filter(Boolean))
      manifests.push(`${parent}/${directory}/package.json`);
  }
  const paths = gitOutput(root, ["ls-tree", "-r", "--name-only", commit, "--", ...manifests])
    .split("\n")
    .filter(Boolean);
  const baselineWorkspacePaths = new Set(paths);
  const baselineScripts = new Map<string, string | undefined>();
  for (const { relativePath } of workspaces) {
    if (!baselineWorkspacePaths.has(relativePath)) continue;
    const content = gitOutput(root, ["show", `${commit}:${relativePath}`]);
    baselineScripts.set(
      relativePath,
      typecheckScript(manifest(content, relativePath), relativePath),
    );
  }
  return { baselineWorkspacePaths, baselineScripts };
}
