import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { downloadNpmArchives } from "./claudeSdkArchives.ts";
import {
  readClaudeSdkLock,
  type ClaudeSdkDependencyPin,
  type InstalledPackage,
} from "./claudeSdkLock.ts";
import type { OfficialReleaseIdentity } from "./releaseIdentity.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const SDK_NAME = "@anthropic-ai/claude-agent-sdk";

export type { ClaudeSdkDependencyPin } from "./claudeSdkLock.ts";

export interface NpmSdkSource {
  readonly root: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly name: string;
  readonly version: string;
}

export interface InstalledClaudeSdkGraph {
  readonly sdk: NpmSdkSource;
  readonly dependencies: ReadonlyArray<NpmSdkSource>;
  readonly npmVersion: string;
  readonly lockfileSha256: string;
  readonly dependencyPins: ReadonlyArray<ClaudeSdkDependencyPin>;
}

function sourceFor(
  entry: InstalledPackage,
  archives: ReadonlyMap<string, { readonly path: string }>,
): NpmSdkSource {
  const archive = archives.get(entry.integrity);
  if (!archive) throw new Error("CLAUDE_SDK_DEPENDENCY_ARCHIVE_MISSING");
  return {
    name: entry.name,
    version: entry.version,
    integrity: entry.integrity,
    root: entry.root,
    tarball: archive.path,
  };
}

/** Install without scripts or optional packages, then pin every installed tarball from npm. */
export async function installClaudeSdkGraph(
  identity: OfficialReleaseIdentity,
  workspace: string,
): Promise<InstalledClaudeSdkGraph> {
  const npm = identity.npm;
  if (identity.provider !== "claude-agent-sdk" || !npm || npm.packageName !== SDK_NAME)
    throw new Error("CLAUDE_SDK_RELEASE_IDENTITY_INVALID");
  const userConfig = NodePath.join(workspace, "npmrc");
  const cache = NodePath.join(workspace, "cache");
  const archivesPath = NodePath.join(workspace, "archives");
  await NodeFSP.mkdir(archivesPath);
  await NodeFSP.writeFile(userConfig, "", { flag: "wx" });
  await NodeFSP.writeFile(
    NodePath.join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "signalbox-claude-agent-sdk-build",
        version: "1.0.0",
        private: true,
        dependencies: { [SDK_NAME]: identity.version },
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );

  const environment = {
    ...process.env,
    npm_config_cache: cache,
    npm_config_userconfig: userConfig,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
  };
  try {
    await execute(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--package-lock=true",
        "--include=peer",
        "--omit=optional",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--registry=https://registry.npmjs.org/",
        `--userconfig=${userConfig}`,
        `--cache=${cache}`,
        "--loglevel=error",
      ],
      {
        cwd: workspace,
        env: environment,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
      },
    );
  } catch (cause) {
    throw new Error("CLAUDE_SDK_DEPENDENCY_INSTALL_FAILED", { cause });
  }

  const npmVersionResult = await execute("npm", ["--version"], {
    cwd: workspace,
    env: environment,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const lock = await readClaudeSdkLock(identity, workspace);
  const archives = await downloadNpmArchives(
    lock.installed.map(({ integrity, resolved }) => ({ integrity, resolved })),
    archivesPath,
  );
  const dependencyPins = [
    ...lock.installed.map((entry): ClaudeSdkDependencyPin => {
      const archive = archives.get(entry.integrity);
      if (!archive) throw new Error("CLAUDE_SDK_DEPENDENCY_ARCHIVE_MISSING");
      return {
        name: entry.name,
        version: entry.version,
        integrity: entry.integrity,
        resolved: entry.resolved,
        optional: entry.optional,
        installed: true,
        tarballSha256: archive.sha256,
        tarballBytes: archive.bytes,
      };
    }),
    ...lock.omitted,
  ].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  const sdkPackage = lock.installed.find((entry) => entry.lockPath === `node_modules/${SDK_NAME}`);
  if (!sdkPackage) throw new Error("CLAUDE_SDK_DEPENDENCY_INSTALL_INCOMPLETE");
  const sdk = sourceFor(sdkPackage, archives);
  if (sdk.integrity !== npm.integrity || sdk.version !== identity.version)
    throw new Error("CLAUDE_SDK_DEPENDENCY_RELEASE_MISMATCH");

  return {
    sdk,
    dependencies: lock.installed
      .filter((entry) => entry !== sdkPackage)
      .map((entry) => sourceFor(entry, archives)),
    npmVersion: npmVersionResult.stdout.trim(),
    lockfileSha256: lock.sha256,
    dependencyPins,
  };
}
