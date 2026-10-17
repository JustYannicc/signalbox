#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This smoke command uses Node APIs to inspect release files.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { cliArchiveFileName } from "./build-cli-archive.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function matchRequired(source: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) throw new Error(`Release artifact smoke could not find ${label}.`);
  return value;
}

const releaseWorkflow = NodeFS.readFileSync(
  NodePath.join(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);
const mobileConfig = NodeFS.readFileSync(
  NodePath.join(repoRoot, "apps/mobile/app.config.ts"),
  "utf8",
);
const productionConfig = matchRequired(
  mobileConfig,
  /^ {2}production: \{([\s\S]*?)^ {2}\},/m,
  "production app config",
);
const productionPackageId = matchRequired(
  productionConfig,
  /^ {4}androidPackage: "([^"]+)"/m,
  "production Android package id",
);
const apkMirrorStep = matchRequired(
  releaseWorkflow,
  /- name: Download internal Android APK for Nightly\n([\s\S]*?)(?=\n      - name: )/,
  "nightly APK mirror step",
);
const releasePackageId = matchRequired(
  apkMirrorStep,
  /^\s+PACKAGE_NAME: (\S+)/m,
  "release Android package id",
);
NodeAssert.equal(
  releasePackageId,
  productionPackageId,
  "The release workflow must request the production Android package.",
);
NodeAssert.match(
  releaseWorkflow,
  /^        run: bash \.github\/scripts\/write-cli-archive-checksums\.sh release-assets$/m,
  "The release workflow must use the smoke-tested CLI checksum selector.",
);

const tempRoot = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "signalbox-release-assets-smoke-"),
);
try {
  const releaseAssets = NodePath.join(tempRoot, "release-assets");
  NodeFS.mkdirSync(releaseAssets);
  const expectedArchives = [
    cliArchiveFileName("9.9.9-smoke.0", "mac", "arm64"),
    cliArchiveFileName("9.9.9-smoke.0", "win", "x64"),
  ];
  for (const archive of expectedArchives) {
    NodeFS.writeFileSync(NodePath.join(releaseAssets, archive), `fixture:${archive}`);
  }
  NodeFS.writeFileSync(NodePath.join(releaseAssets, "t3-9.9.9-smoke.0-linux-x64.tar.gz"), "old");
  NodeFS.writeFileSync(NodePath.join(releaseAssets, "signalbox-not-an-archive.txt"), "other");

  NodeChildProcess.execFileSync(
    "bash",
    [NodePath.join(repoRoot, ".github/scripts/write-cli-archive-checksums.sh"), releaseAssets],
    { cwd: repoRoot, stdio: "ignore" },
  );

  const checksums = NodeFS.readFileSync(NodePath.join(releaseAssets, "SHA256SUMS"), "utf8")
    .trim()
    .split(/\r?\n/);
  const listedArchives = checksums.map((line) => line.replace(/^[0-9a-f]{64}\s+\*?/, ""));
  NodeAssert.deepEqual(listedArchives.slice().sort(), expectedArchives.slice().sort());
  for (const archive of expectedArchives) {
    const content = NodeFS.readFileSync(NodePath.join(releaseAssets, archive));
    const hash = NodeCrypto.createHash("sha256").update(content).digest("hex");
    NodeAssert.ok(checksums.includes(`${hash}  ${archive}`));
  }
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}

Effect.runSync(Console.log("Release artifact smoke checks passed."));
