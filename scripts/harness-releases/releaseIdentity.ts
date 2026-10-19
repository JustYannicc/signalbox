import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { isStrictStableVersion, type HarnessProvider } from "./discovery.ts";
import { object, sha256 } from "./fixture.ts";
import { text as asText } from "./guards.ts";

export const claudeReleaseBase =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

export interface OfficialReleaseIdentity {
  readonly provider: HarnessProvider;
  readonly version: string;
  readonly upstreamIdentity: string;
  readonly sha256: string;
  readonly npm?: {
    readonly packageName: string;
    readonly integrity: string;
    readonly tarball: string;
  };
  readonly binary?: {
    readonly platform: "linux-x64";
    readonly sourceURL: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly manifestSha256: string;
  };
  readonly codex?: {
    readonly repository: "https://github.com/openai/codex.git";
    readonly tag: string;
    readonly commit: string;
  };
}

export type IdentityHttp = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

function text(value: unknown): string {
  return asText(value, "RELEASE_IDENTITY_TEXT_REQUIRED");
}

function commit(value: unknown) {
  const sha = text(value);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("RELEASE_IDENTITY_COMMIT_REQUIRED");
  return sha;
}

export function assertReleaseSelection(
  provider: string,
  version: string,
): asserts provider is HarnessProvider {
  if (!["claude-code", "claude-agent-sdk", "codex"].includes(provider))
    throw new Error("RELEASE_PROVIDER_REQUIRED");
  if (!isStrictStableVersion(version)) throw new Error("RELEASE_EXACT_STABLE_VERSION_REQUIRED");
}

/** Decode the identity file at the CLI boundary before the build consumes it. */
export function parseOfficialReleaseIdentity(value: unknown): OfficialReleaseIdentity {
  const input = object(value);
  const provider = text(input.provider);
  const version = text(input.version);
  const upstreamIdentity = text(input.upstreamIdentity);
  assertReleaseSelection(provider, version);
  const sha = text(input.sha256);
  if (!/^[a-f0-9]{64}$/u.test(sha)) throw new Error("RELEASE_IDENTITY_HASH_INVALID");

  let identity: Omit<OfficialReleaseIdentity, "sha256">;
  if (provider === "codex") {
    const codex = object(input.codex);
    if (
      input.npm !== undefined ||
      input.binary !== undefined ||
      upstreamIdentity !== `github:openai/codex:rust-v${version}` ||
      codex.repository !== "https://github.com/openai/codex.git" ||
      codex.tag !== `rust-v${version}`
    )
      throw new Error("RELEASE_CODEX_IDENTITY_INVALID");
    identity = {
      provider,
      version,
      upstreamIdentity,
      codex: {
        repository: "https://github.com/openai/codex.git",
        tag: `rust-v${version}`,
        commit: commit(codex.commit),
      },
    };
  } else {
    const packageName = `@anthropic-ai/${provider}`;
    const npm = object(input.npm);
    const integrity = text(npm.integrity);
    const integrityBytes = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity)?.[1];
    const tarball = new URL(text(npm.tarball));
    if (
      upstreamIdentity !== `npm:${packageName}` ||
      npm.packageName !== packageName ||
      !integrityBytes ||
      Buffer.from(integrityBytes, "base64").byteLength !== 64 ||
      tarball.origin !== "https://registry.npmjs.org" ||
      tarball.username ||
      tarball.password
    )
      throw new Error("RELEASE_NPM_IDENTITY_INVALID");
    let binary: OfficialReleaseIdentity["binary"];
    if (provider === "claude-code") {
      const value = object(input.binary);
      if (
        value.platform !== "linux-x64" ||
        value.sourceURL !== `${claudeReleaseBase}/${version}/linux-x64/claude` ||
        !Number.isSafeInteger(value.bytes) ||
        typeof value.bytes !== "number" ||
        value.bytes <= 0 ||
        typeof value.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sha256) ||
        typeof value.manifestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.manifestSha256)
      )
        throw new Error("RELEASE_CLAUDE_BINARY_IDENTITY_INVALID");
      binary = {
        platform: "linux-x64",
        sourceURL: `${claudeReleaseBase}/${version}/linux-x64/claude`,
        bytes: value.bytes,
        sha256: value.sha256,
        manifestSha256: value.manifestSha256,
      };
    } else if (input.binary !== undefined) {
      throw new Error("RELEASE_SDK_BINARY_IDENTITY_INVALID");
    }
    identity = {
      provider,
      version,
      upstreamIdentity,
      npm: { packageName, integrity, tarball: tarball.toString() },
      ...(binary ? { binary } : {}),
    };
  }
  if (sha !== sha256(JSON.stringify(identity))) throw new Error("RELEASE_IDENTITY_HASH_MISMATCH");
  return { ...identity, sha256: sha };
}

/** Resolve mutable registries once, then use only this frozen identity throughout the run. */
export async function resolveOfficialRelease(
  provider: HarnessProvider,
  version: string,
  http: IdentityHttp = (url) => fetch(url, { signal: AbortSignal.timeout(60_000) }),
): Promise<OfficialReleaseIdentity> {
  assertReleaseSelection(provider, version);
  const json = async (url: string) => {
    const response = await http(url);
    if (!response.ok) throw new Error(`RELEASE_IDENTITY_HTTP_${response.status}`);
    return object(await response.json());
  };
  if (provider === "codex") {
    const tag = `rust-v${version}`;
    const base = "https://api.github.com/repos/openai/codex";
    const release = await json(`${base}/releases/tags/${tag}`);
    if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false)
      throw new Error("RELEASE_IDENTITY_STABLE_TAG_MISMATCH");
    const reference = await json(`${base}/git/ref/tags/${tag}`);
    if (reference.ref !== `refs/tags/${tag}`) throw new Error("RELEASE_IDENTITY_TAG_MISMATCH");
    let target = object(reference.object);
    const seen = new Set<string>();
    for (let depth = 0; target.type === "tag"; depth++) {
      const sha = commit(target.sha);
      if (depth >= 8 || seen.has(sha)) throw new Error("RELEASE_IDENTITY_TAG_PEEL_FAILED");
      seen.add(sha);
      target = object((await json(`${base}/git/tags/${sha}`)).object);
    }
    if (target.type !== "commit") throw new Error("RELEASE_IDENTITY_NOT_COMMIT");
    const identity = {
      provider,
      version,
      upstreamIdentity: `github:openai/codex:${tag}`,
      codex: {
        repository: "https://github.com/openai/codex.git" as const,
        tag,
        commit: commit(target.sha),
      },
    };
    return { ...identity, sha256: sha256(JSON.stringify(identity)) };
  }
  const packageName = `@anthropic-ai/${provider}`;
  const metadata = await json(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`,
  );
  if (metadata.name !== packageName || metadata.version !== version)
    throw new Error("RELEASE_IDENTITY_NPM_MISMATCH");
  const dist = object(metadata.dist);
  const integrity = text(dist.integrity);
  const integrityBytes = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity)?.[1];
  if (!integrityBytes || Buffer.from(integrityBytes, "base64").length !== 64)
    throw new Error("RELEASE_IDENTITY_INTEGRITY_REQUIRED");
  const tarball = new URL(text(dist.tarball));
  if (tarball.origin !== "https://registry.npmjs.org" || tarball.username || tarball.password)
    throw new Error("RELEASE_IDENTITY_NPM_ORIGIN_MISMATCH");
  let binary: OfficialReleaseIdentity["binary"];
  if (provider === "claude-code") {
    const manifest = await json(`${claudeReleaseBase}/${version}/manifest.json`);
    if (manifest.version !== version) throw new Error("RELEASE_IDENTITY_BINARY_VERSION_MISMATCH");
    const artifact = object(object(manifest.platforms)["linux-x64"]);
    if (
      artifact.binary !== "claude" ||
      !Number.isSafeInteger(artifact.size) ||
      typeof artifact.size !== "number" ||
      artifact.size <= 0 ||
      typeof artifact.checksum !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.checksum)
    )
      throw new Error("RELEASE_IDENTITY_BINARY_INVALID");
    binary = {
      platform: "linux-x64",
      sourceURL: `${claudeReleaseBase}/${version}/linux-x64/claude`,
      bytes: artifact.size,
      sha256: artifact.checksum,
      manifestSha256: sha256(JSON.stringify(manifest)),
    };
  }
  const identity = {
    provider,
    version,
    upstreamIdentity: `npm:${packageName}`,
    npm: { packageName, integrity, tarball: tarball.toString() },
    ...(binary ? { binary } : {}),
  };
  return { ...identity, sha256: sha256(JSON.stringify(identity)) };
}

/** Keep the wrapper, toolchain and reference pins identical across release candidates. */
export function codexBuildPin(base: unknown, identity: OfficialReleaseIdentity) {
  const pin = object(base);
  if (
    identity.provider !== "codex" ||
    !identity.codex ||
    pin.repository !== identity.codex.repository ||
    !Array.isArray(pin.targets) ||
    !pin.targets.includes("wasm32-wasip1")
  )
    throw new Error("RELEASE_CODEX_PIN_MISMATCH");
  return {
    ...pin,
    version: identity.version,
    tag: identity.codex.tag,
    commit: identity.codex.commit,
  };
}

export function newReleaseRunId() {
  return NodeCrypto.randomUUID();
}

export interface ArtifactIdentity {
  readonly sha256: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
}

/** Hash the manifest and recheck every declared payload before assigning a candidate identity. */
export async function freezeArtifact(directory: string): Promise<ArtifactIdentity> {
  const root = await NodeFSP.realpath(directory);
  const read = async (path: string) => {
    if (
      NodePath.isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("RELEASE_ARTIFACT_PATH_INVALID");
    const file = NodePath.join(root, path);
    if (!(await NodeFSP.lstat(file)).isFile() || (await NodeFSP.realpath(file)) !== file)
      throw new Error("RELEASE_ARTIFACT_NOT_REGULAR");
    return NodeFSP.readFile(file);
  };
  const bytes = await read("manifest.json");
  const manifest = object(JSON.parse(bytes.toString("utf8")));
  const declared =
    manifest.files === undefined
      ? [...Object.values(object(manifest.modules)), ...Object.values(object(manifest.assets))].map(
          object,
        )
      : Object.entries(object(manifest.files)).map(([path, entry]) => ({ ...object(entry), path }));
  if (!declared.length) throw new Error("RELEASE_ARTIFACT_EMPTY");
  const files = [];
  for (const raw of declared) {
    const item = object(raw);
    const path = text(item.path);
    const payload = await read(path);
    const actual = { path, bytes: payload.length, sha256: sha256(payload) };
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256)
      throw new Error("RELEASE_ARTIFACT_INVENTORY_MISMATCH");
    files.push(actual);
  }
  if (manifest.moduleMap !== undefined) {
    const entry = object(manifest.moduleMap);
    const path = text(entry.path);
    const payload = await read(path);
    const actual = { path, bytes: payload.length, sha256: sha256(payload) };
    if (actual.sha256 !== entry.sha256) throw new Error("RELEASE_ARTIFACT_MODULE_MAP_MISMATCH");
    files.push(actual);
  }
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("RELEASE_ARTIFACT_DUPLICATE_PATH");
  return { sha256: sha256(bytes), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
