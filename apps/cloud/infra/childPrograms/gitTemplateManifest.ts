// @effect-diagnostics nodeBuiltinImport:off - verifies the pinned Git template manifest.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const manifestPath = NodePath.join(import.meta.dirname, "gitTemplates.manifest.json");
const manifestSha256 = "8ac13af66a67728a7c9d25aa2df6f13dce5ac3c9afc7c98fda46770451a989ee";
const assetPrefix = "git-templates/files/usr/share/git-core/templates";
const guestTemplateRoot = "/usr/share/git-core/templates";

const templatePaths = [
  "description",
  "hooks/applypatch-msg.sample",
  "hooks/commit-msg.sample",
  "hooks/fsmonitor-watchman.sample",
  "hooks/post-update.sample",
  "hooks/pre-applypatch.sample",
  "hooks/pre-commit.sample",
  "hooks/pre-merge-commit.sample",
  "hooks/prepare-commit-msg.sample",
  "hooks/pre-push.sample",
  "hooks/pre-rebase.sample",
  "hooks/pre-receive.sample",
  "hooks/push-to-checkout.sample",
  "hooks/sendemail-validate.sample",
  "hooks/update.sample",
  "info/exclude",
] as const;

const templateDirectories = [
  "/usr/share/git-core/templates",
  "/usr/share/git-core/templates/hooks",
  "/usr/share/git-core/templates/info",
] as const;
const assetDirectories = [
  "git-templates/files/usr/share/git-core/templates",
  "git-templates/files/usr/share/git-core/templates/hooks",
  "git-templates/files/usr/share/git-core/templates/info",
] as const;

export const GIT_TEMPLATE_ASSET_ROOT = "git-templates";

export interface GitTemplateManifestFile {
  readonly relativeInstallPath: string;
  readonly path: string;
  readonly assetPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
}

export interface PinnedGitTemplateManifest {
  readonly files: readonly GitTemplateManifestFile[];
}

export async function readPinnedGitTemplateManifest(): Promise<PinnedGitTemplateManifest> {
  const bytes = await NodeFSP.readFile(manifestPath);
  if (sha256(bytes) !== manifestSha256) throw new Error("Pinned Git template manifest changed");
  return validateManifest(JSON.parse(bytes.toString("utf8")));
}

export function stripGitTemplateAssetPath(path: string): string {
  const prefix = `${GIT_TEMPLATE_ASSET_ROOT}/`;
  if (!path.startsWith(prefix)) throw new Error(`Invalid Git template asset path ${path}`);
  const relativePath = path.slice(prefix.length);
  if (
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid Git template asset path ${path}`);
  }
  return relativePath;
}

function validateManifest(value: unknown): PinnedGitTemplateManifest {
  const manifest = record(value, "Git template manifest");
  const source = record(manifest.source, "Git template source");
  const installerSource = record(manifest.installerSource, "Git template installer source");
  const installation = record(manifest.installation, "Git template installation");
  const license = record(manifest.license, "Git template license");
  if (
    manifest.format !== "signalbox-git-template-assets-v1" ||
    source.version !== "2.53.0" ||
    source.archiveSha256 !== "5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653" ||
    installerSource.commit !== "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3" ||
    installation.prefix !== "/usr" ||
    installation.templateDirectory !== guestTemplateRoot ||
    installation.shellPath !== "/bin/sh" ||
    installation.perlPath !== "perl" ||
    license.spdx !== "GPL-2.0-only"
  ) {
    throw new Error("Git template manifest provenance changed");
  }

  const directories = array(manifest.directories, "Git template directories");
  if (directories.length !== templateDirectories.length) {
    throw new Error("Git template directory list changed");
  }
  templateDirectories.forEach((path, index) => {
    const directory = record(directories[index], "Git template directory");
    if (
      directory.path !== path ||
      directory.assetPath !== assetDirectories[index] ||
      directory.mode !== "0755"
    ) {
      throw new Error(`Unexpected Git template directory ${String(directory.path)}`);
    }
  });

  const entries = array(manifest.files, "Git template files");
  if (entries.length !== templatePaths.length) throw new Error("Git template file list changed");
  const files = entries.map((value, index) => {
    const entry = record(value, "Git template file");
    const relativeInstallPath = templatePaths[index]!;
    const expectedMode =
      relativeInstallPath === "description" || relativeInstallPath === "info/exclude"
        ? 0o644
        : 0o755;
    const expected = {
      relativeInstallPath,
      path: `${guestTemplateRoot}/${relativeInstallPath}`,
      assetPath: `${assetPrefix}/${relativeInstallPath}`,
      sourceMember: `git-2.53.0/templates/${relativeInstallPath}`,
    };
    if (
      entry.relativeInstallPath !== expected.relativeInstallPath ||
      entry.path !== expected.path ||
      entry.assetPath !== expected.assetPath ||
      entry.sourceMember !== expected.sourceMember ||
      entry.mode !== expectedMode.toString(8).padStart(4, "0") ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) <= 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`Invalid pinned Git template manifest entry ${expected.path}`);
    }
    return Object.freeze({
      relativeInstallPath,
      path: expected.path,
      assetPath: expected.assetPath,
      bytes: entry.bytes as number,
      sha256: entry.sha256,
      mode: expectedMode,
    });
  });
  return Object.freeze({ files: Object.freeze(files) });
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
