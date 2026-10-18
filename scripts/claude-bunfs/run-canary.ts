// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - prepares official release inputs for the shared isolate-probe host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { extractRelease, releaseBase, requiredVersions } from "./releases.ts";

const PLATFORM = "linux-x64";
const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));

function fail(message: string): never {
  throw new Error(message);
}

async function readLatestVersion() {
  const response = await fetch(`${releaseBase}/latest`);
  if (!response.ok) fail(`Latest Claude release lookup failed (HTTP ${response.status}).`);
  const version = (await response.text()).trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    fail("Official latest release did not return a strict semantic version.");
  }
  return version;
}

async function extractWithoutPaths(version: string, output: string) {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await extractRelease(version, output, PLATFORM);
  } finally {
    console.log = originalLog;
  }
}

async function releasePin(version: string, directory: string) {
  let release: unknown;
  try {
    release = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, ".bun-data/release.json"), "utf8"),
    );
  } catch {
    fail(`Official release pin for ${version} could not be read.`);
  }
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    fail(`Official release pin for ${version} is invalid.`);
  }
  const manifest = (release as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`Official release pin for ${version} has no release manifest.`);
  }
  const platforms = (manifest as { platforms?: unknown }).platforms;
  const artifact =
    platforms && typeof platforms === "object" && !Array.isArray(platforms)
      ? (platforms as Record<string, unknown>)[PLATFORM]
      : undefined;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    fail(`Official release pin for ${version} has no ${PLATFORM} binary.`);
  }
  const binary = artifact as { binary?: unknown; size?: unknown; checksum?: unknown };
  if (
    typeof binary.binary !== "string" ||
    typeof binary.size !== "number" ||
    !Number.isSafeInteger(binary.size) ||
    typeof binary.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(binary.checksum)
  ) {
    fail(`Official release pin for ${version} is incomplete.`);
  }
  return {
    version,
    platform: PLATFORM,
    sourceURL: `${releaseBase}/${version}/manifest.json`,
    binary: binary.binary,
    bytes: binary.size,
    sha256: binary.checksum,
  };
}

async function main() {
  const outputArg = process.argv[2];
  if (!outputArg) fail("Usage: node run-canary.ts <artifact-directory>");
  const selection = process.argv[3] || process.env.CANARY_SELECTION || "";
  if (selection !== "" && selection !== "latest") {
    fail("The optional canary selection must be 'latest'.");
  }
  const output = NodePath.resolve(outputArg);
  await NodeFSP.mkdir(output, { recursive: true });

  const latest = await readLatestVersion();
  const versions = selection === "latest" ? [latest] : [...new Set([...requiredVersions, latest])];
  const cases: { version: string; platform: string; manifest: string }[] = [];
  const pins = [];
  for (const version of versions) {
    const directory = await extractWithoutPaths(version, output);
    pins.push(await releasePin(version, directory));
    cases.push({
      version,
      platform: PLATFORM,
      manifest: `graph-${version}-${PLATFORM}/manifest.json`,
    });
  }

  const fixture = NodePath.join(output, "fixture");
  const prepareFixture = NodeURL.fileURLToPath(new URL("./prepare-fixture.ts", import.meta.url));
  const prepared = NodeChildProcess.spawnSync(
    process.execPath,
    [prepareFixture, fixture, versions.join(",")],
    { cwd: root, stdio: "inherit" },
  );
  if (prepared.error || prepared.status !== 0) {
    fail("Could not prepare the shared isolate-probe fixture.");
  }

  await NodeFSP.writeFile(
    NodePath.join(output, "release-pins.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: "official Claude Code release distribution",
        latest,
        releases: pins,
      },
      null,
      2,
    )}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(output, "canary-index.json"),
    `${JSON.stringify({ schemaVersion: 1, versions, cases }, null, 2)}\n`,
  );
  process.stdout.write(
    `Prepared ${versions.length} official release cases for the isolate-probe host.\n`,
  );
}

await main();
