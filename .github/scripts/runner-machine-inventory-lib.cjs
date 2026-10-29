"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PIN_PATH = path.join(__dirname, "runner-machine-inventory.pin.json");
const DOCKERFILE = "apps/server/src/signalbox/runner/image/Dockerfile";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageDigestFromRef(imageRef) {
  const match = /^ghcr\.io\/justyannicc\/signalbox-runner@(sha256:[a-f0-9]{64})$/.exec(imageRef);
  if (!match) throw new Error(`Invalid pinned Runner image reference: ${imageRef}`);
  return match[1];
}

function releaseTagForDigest(imageDigest) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(imageDigest);
  if (!match) throw new Error(`Invalid Runner image digest: ${imageDigest}`);
  return `runner-machine-files-${match[1].slice(0, 12)}`;
}

function validatePin(pin) {
  if (pin.schemaVersion !== 1) throw new Error("Unsupported Runner inventory pin schema");
  if (pin.repository !== "JustYannicc/signalbox")
    throw new Error("Unexpected Runner inventory repository");
  if (pin.assetName !== "runner.json") throw new Error("Unexpected Runner inventory asset name");
  if (!/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error("Invalid Runner inventory SHA-256 pin");
  if (!/^[a-f0-9]{40}$/.test(pin.sourceRevision))
    throw new Error("Invalid Runner source revision pin");
  if (!/^sha256:[a-f0-9]{64}$/.test(pin.sourceImageId))
    throw new Error("Invalid Runner source image ID pin");
  if (!/^[a-f0-9]{64}$/.test(pin.captureSha256))
    throw new Error("Invalid Runner capture SHA-256 pin");
  if (pin.platform !== "linux/amd64") throw new Error("Unexpected Runner inventory platform pin");
  const digest = imageDigestFromRef(pin.imageRef);
  if (pin.releaseTag !== releaseTagForDigest(digest))
    throw new Error("Runner inventory release tag does not match its pinned image digest");
  if (!pin.sourceArtifact || pin.sourceArtifact.workflow !== ".github/workflows/runner-image.yml")
    throw new Error("Runner inventory pin is missing its source workflow record");
  return pin;
}

function parseInventory(bytes, label = "Runner inventory") {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function verifyInventoryBytes(bytes, pin) {
  validatePin(pin);
  const data = Buffer.from(bytes);
  const actualSha256 = sha256(data);
  if (actualSha256 !== pin.sha256)
    throw new Error(
      `Runner inventory SHA-256 mismatch: expected ${pin.sha256}, got ${actualSha256}`,
    );

  const inventory = parseInventory(data);
  const imageDigest = imageDigestFromRef(pin.imageRef);
  if (inventory.format !== "signalbox-machine-files-v1")
    throw new Error(`Unexpected Runner inventory format: ${inventory.format}`);
  if (inventory.imageRef !== pin.imageRef || inventory.imageDigest !== imageDigest)
    throw new Error("Runner inventory image reference does not match the pinned image digest");
  if (inventory.platform !== pin.platform)
    throw new Error("Runner inventory platform does not match the pin");
  if (inventory.provenance?.sourceRevision !== pin.sourceRevision)
    throw new Error("Runner inventory source revision does not match the pin");
  if (inventory.provenance?.sourceImageId !== pin.sourceImageId)
    throw new Error("Runner inventory source image ID does not match the pin");
  if (inventory.provenance?.dockerfile !== DOCKERFILE)
    throw new Error("Runner inventory Dockerfile does not match the expected source");
  if (inventory.provenance?.captureSha256 !== pin.captureSha256)
    throw new Error("Runner inventory capture hash does not match the pin");
  if (inventory.imageContent?.imageDigest !== imageDigest)
    throw new Error("Runner image-content digest does not match the pinned image");
  if (inventory.imageContent?.captureSha256 !== pin.captureSha256)
    throw new Error("Runner image-content capture hash does not match the pin");
  return inventory;
}

function verifyPublishedInventory(bytes, expected) {
  const inventory = parseInventory(bytes);
  const imageDigest = imageDigestFromRef(expected.imageRef);
  if (inventory.format !== "signalbox-machine-files-v1")
    throw new Error(`Unexpected Runner inventory format: ${inventory.format}`);
  if (inventory.imageRef !== expected.imageRef || inventory.imageDigest !== imageDigest)
    throw new Error("Runner inventory does not describe the published Runner image");
  if (inventory.platform !== expected.platform)
    throw new Error("Runner inventory platform changed during capture");
  if (inventory.provenance?.sourceRevision !== expected.sourceRevision)
    throw new Error("Runner inventory source revision changed during capture");
  if (inventory.provenance?.sourceImageId !== expected.sourceImageId)
    throw new Error("Runner inventory source image ID changed during capture");
  if (inventory.provenance?.dockerfile !== DOCKERFILE)
    throw new Error("Runner inventory Dockerfile does not match the expected source");
  if (inventory.imageContent?.imageDigest !== imageDigest)
    throw new Error("Runner image-content digest does not match the published image");
  if (inventory.provenance?.captureSha256 !== inventory.imageContent?.captureSha256)
    throw new Error("Runner image-content capture hash disagrees with its provenance");
  return { inventory, imageDigest, sha256: sha256(bytes) };
}

function callGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readRelease(repository, tag, runGh = callGh) {
  try {
    return JSON.parse(
      runGh(["api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`]),
    );
  } catch (error) {
    const detail = `${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (/HTTP 404: Not Found/.test(detail)) return undefined;
    throw error;
  }
}

function downloadAsset({ repository, tag, assetName, directory, runGh = callGh }) {
  runGh([
    "release",
    "download",
    tag,
    "--repo",
    repository,
    "--pattern",
    assetName,
    "--dir",
    directory,
  ]);
  const assetPath = path.join(directory, assetName);
  if (!fs.existsSync(assetPath)) throw new Error(`GitHub release did not download ${assetName}`);
  return fs.readFileSync(assetPath);
}

module.exports = {
  PIN_PATH,
  callGh,
  downloadAsset,
  imageDigestFromRef,
  parseInventory,
  readRelease,
  releaseTagForDigest,
  sha256,
  validatePin,
  verifyInventoryBytes,
  verifyPublishedInventory,
};
