import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { readExtraction } from "../claude-bunfs/extracted-input.ts";
import {
  assertReleaseSelection,
  claudeReleaseBase,
  type OfficialReleaseIdentity,
} from "./releaseIdentity.ts";
import { digest, record, sha256, text } from "./guards.ts";

function positiveBytes(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(code);
  return value;
}

export function validateClaudeReleaseIdentity(identity: OfficialReleaseIdentity, platform: string) {
  if (identity.provider !== "claude-code")
    throw new Error("CLAUDE_RELEASE_IDENTITY_PROVIDER_MISMATCH");
  assertReleaseSelection(identity.provider, identity.version);
  if (identity.upstreamIdentity !== "npm:@anthropic-ai/claude-code")
    throw new Error("CLAUDE_RELEASE_IDENTITY_UPSTREAM_MISMATCH");
  const { sha256: identitySha256, ...payload } = identity;
  if (
    digest(identitySha256, "CLAUDE_RELEASE_IDENTITY_HASH_INVALID") !==
    sha256(JSON.stringify(payload))
  )
    throw new Error("CLAUDE_RELEASE_IDENTITY_HASH_MISMATCH");

  const npm = record(identity.npm, "CLAUDE_RELEASE_NPM_IDENTITY_REQUIRED");
  if (
    npm.packageName !== "@anthropic-ai/claude-code" ||
    typeof npm.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(npm.integrity) ||
    Buffer.from(npm.integrity.slice(7), "base64").byteLength !== 64
  )
    throw new Error("CLAUDE_RELEASE_NPM_IDENTITY_INVALID");
  const tarball = new URL(text(npm.tarball, "CLAUDE_RELEASE_NPM_TARBALL_REQUIRED"));
  if (tarball.origin !== "https://registry.npmjs.org" || tarball.username || tarball.password)
    throw new Error("CLAUDE_RELEASE_NPM_ORIGIN_MISMATCH");

  const binary = record(identity.binary, "CLAUDE_RELEASE_BINARY_IDENTITY_REQUIRED");
  if (binary.platform !== platform) throw new Error("CLAUDE_RELEASE_BINARY_PLATFORM_MISMATCH");
  if (binary.sourceURL !== `${claudeReleaseBase}/${identity.version}/${platform}/claude`)
    throw new Error("CLAUDE_RELEASE_BINARY_SOURCE_MISMATCH");
  return {
    bytes: positiveBytes(binary.bytes, "CLAUDE_RELEASE_BINARY_SIZE_INVALID"),
    sha256: digest(binary.sha256, "CLAUDE_RELEASE_BINARY_SHA_INVALID"),
    manifestSha256: digest(binary.manifestSha256, "CLAUDE_RELEASE_MANIFEST_SHA_INVALID"),
    sourceURL: binary.sourceURL as string,
  };
}

export async function verifyClaudeExtraction(
  extracted: string,
  identity: OfficialReleaseIdentity,
  platform: string,
) {
  const binary = validateClaudeReleaseIdentity(identity, platform);
  const extractionManifestBytes = await NodeFSP.readFile(NodePath.join(extracted, "manifest.json"));
  const extractionManifest = record(
    JSON.parse(extractionManifestBytes.toString("utf8")),
    "CLAUDE_EXTRACTION_MANIFEST_INVALID",
  );
  const extractionBinary = record(extractionManifest.binary, "CLAUDE_EXTRACTION_BINARY_INVALID");
  const extractedSha256 = digest(extractionBinary.sha256, "CLAUDE_EXTRACTION_BINARY_SHA_INVALID");
  const extractedBytes = positiveBytes(
    extractionBinary.bytes,
    "CLAUDE_EXTRACTION_BINARY_SIZE_INVALID",
  );
  const releaseBytes = await NodeFSP.readFile(NodePath.join(extracted, ".bun-data/release.json"));
  const release = record(
    JSON.parse(releaseBytes.toString("utf8")),
    "CLAUDE_RELEASE_RECORD_INVALID",
  );
  const officialManifest = record(release.manifest, "CLAUDE_OFFICIAL_MANIFEST_INVALID");
  const manifestSha256 = sha256(JSON.stringify(officialManifest));
  if (
    release.version !== identity.version ||
    release.platform !== platform ||
    release.source !== binary.sourceURL ||
    officialManifest.version !== identity.version ||
    manifestSha256 !== binary.manifestSha256
  )
    throw new Error("CLAUDE_OFFICIAL_RELEASE_RECORD_MISMATCH");
  const official = record(
    record(officialManifest.platforms, "CLAUDE_OFFICIAL_PLATFORMS_INVALID")[platform],
    "CLAUDE_OFFICIAL_PLATFORM_INVALID",
  );
  if (
    official.binary !== "claude" ||
    digest(official.checksum, "CLAUDE_OFFICIAL_BINARY_SHA_INVALID") !== binary.sha256 ||
    positiveBytes(official.size, "CLAUDE_OFFICIAL_BINARY_SIZE_INVALID") !== binary.bytes ||
    extractedSha256 !== binary.sha256 ||
    extractedBytes !== binary.bytes
  )
    throw new Error("CLAUDE_OFFICIAL_BINARY_MISMATCH");

  await readExtraction(extracted);
  return {
    extractionManifestSha256: sha256(extractionManifestBytes),
    officialManifestSha256: manifestSha256,
    officialReleaseRecordSha256: sha256(releaseBytes),
    binary,
  };
}
