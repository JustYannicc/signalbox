"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  callGh,
  downloadAsset,
  readRelease,
  releaseTagForDigest,
  sha256,
  verifyPublishedInventory,
} = require("./runner-machine-inventory-lib.cjs");

function validatePublishedRelease(release, tag, assetName, requireAsset = true) {
  if (!release || release.tag_name !== tag)
    throw new Error(`Runner inventory release ${tag} was not created`);
  if (release.draft) throw new Error(`Runner inventory release ${tag} is still a draft`);
  if (!Array.isArray(release.assets))
    throw new Error(`Runner inventory release ${tag} has no asset list`);
  if (requireAsset && !release.assets.some(({ name }) => name === assetName))
    throw new Error(`Runner inventory release ${tag} has no ${assetName} asset`);
}

function publishInventory({
  inventoryPath,
  repository,
  imageRef,
  sourceRevision,
  sourceImageId,
  platform,
  runGh = callGh,
}) {
  if (repository !== "JustYannicc/signalbox")
    throw new Error(`Unexpected release repository: ${repository}`);
  if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Invalid source revision");
  const expected = { imageRef, sourceRevision, sourceImageId, platform };
  const bytes = fs.readFileSync(inventoryPath);
  const verified = verifyPublishedInventory(bytes, expected);
  const tag = releaseTagForDigest(verified.imageDigest);
  const assetName = "runner.json";
  const releaseNotes = [
    `Runner machine-file inventory for ${imageRef}.`,
    "",
    `Source revision: ${sourceRevision}`,
    `SHA-256: ${verified.sha256}`,
  ].join("\n");

  let release = readRelease(repository, tag, runGh);
  if (!release) {
    try {
      runGh([
        "release",
        "create",
        tag,
        inventoryPath,
        "--repo",
        repository,
        "--target",
        sourceRevision,
        "--title",
        `Runner machine files ${verified.imageDigest.slice(7, 19)}`,
        "--notes",
        releaseNotes,
        "--prerelease",
        "--latest=false",
      ]);
    } catch (error) {
      release = readRelease(repository, tag, runGh);
      if (!release) throw error;
    }
    release = readRelease(repository, tag, runGh);
  }

  validatePublishedRelease(release, tag, assetName, false);
  if (!release.assets.some(({ name }) => name === assetName)) {
    try {
      runGh(["release", "upload", tag, inventoryPath, "--repo", repository]);
    } catch (error) {
      release = readRelease(repository, tag, runGh);
      if (!release?.assets?.some(({ name }) => name === assetName)) throw error;
    }
    release = readRelease(repository, tag, runGh);
  }

  validatePublishedRelease(release, tag, assetName);
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "signalbox-runner-inventory-release-"),
  );
  try {
    const publishedBytes = downloadAsset({
      repository,
      tag,
      assetName,
      directory: temporaryDirectory,
      runGh,
    });
    const publishedSha256 = sha256(publishedBytes);
    if (publishedSha256 !== verified.sha256)
      throw new Error(
        `Immutable Runner inventory release conflict for ${tag}: expected ${verified.sha256}, got ${publishedSha256}`,
      );
    verifyPublishedInventory(publishedBytes, expected);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return { tag, sha256: verified.sha256 };
}

function main(argv) {
  if (argv.length !== 3 || argv[0] !== "publish" || argv[1] !== "--inventory")
    throw new Error("Usage: publish-runner-machine-inventory.cjs publish --inventory PATH");
  const inventoryPath = argv[2];
  if (!inventoryPath) throw new Error("publish requires an inventory path");
  const result = publishInventory({
    inventoryPath,
    repository: process.env.GITHUB_REPOSITORY,
    imageRef: process.env.RUNNER_IMAGE_REF,
    sourceRevision: process.env.GITHUB_SHA,
    sourceImageId: process.env.RUNNER_IMAGE_ID,
    platform: process.env.RUNNER_PLATFORM,
  });
  process.stdout.write(`Published ${result.tag} (${result.sha256})\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { publishInventory };
