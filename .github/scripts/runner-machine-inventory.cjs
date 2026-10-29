"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PIN_PATH,
  callGh,
  downloadAsset,
  readRelease,
  validatePin,
  verifyInventoryBytes,
} = require("./runner-machine-inventory-lib.cjs");

function validateRelease(release, pin) {
  if (!release || release.tag_name !== pin.releaseTag)
    throw new Error(`Required Runner inventory release ${pin.releaseTag} is missing`);
  if (release.draft) throw new Error(`Runner inventory release ${pin.releaseTag} is still a draft`);
  if (!Array.isArray(release.assets) || !release.assets.some(({ name }) => name === pin.assetName))
    throw new Error(`Runner inventory release ${pin.releaseTag} has no ${pin.assetName} asset`);
}

function downloadPinnedInventory({
  outputPath,
  pin = JSON.parse(fs.readFileSync(PIN_PATH, "utf8")),
  repository = pin.repository,
  runGh = callGh,
}) {
  validatePin(pin);
  if (repository !== pin.repository)
    throw new Error("Runner inventory repository does not match the pin");
  const release = readRelease(repository, pin.releaseTag, runGh);
  validateRelease(release, pin);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "signalbox-runner-inventory-"));
  try {
    const bytes = downloadAsset({
      repository,
      tag: pin.releaseTag,
      assetName: pin.assetName,
      directory: temporaryDirectory,
      runGh,
    });
    verifyInventoryBytes(bytes, pin);
    const absoluteOutputPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    const stagedPath = `${absoluteOutputPath}.${process.pid}.tmp`;
    fs.writeFileSync(stagedPath, bytes);
    fs.renameSync(stagedPath, absoluteOutputPath);
    return { outputPath: absoluteOutputPath, sha256: pin.sha256 };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.length !== 3 || argv[0] !== "download" || argv[1] !== "--output")
    throw new Error("Usage: runner-machine-inventory.cjs download --output PATH");
  const outputPath = argv[2];
  if (!outputPath) throw new Error("download requires an output path");
  const result = downloadPinnedInventory({ outputPath });
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${result.outputPath}\n`);
  const pin = JSON.parse(fs.readFileSync(PIN_PATH, "utf8"));
  process.stdout.write(`Verified ${result.sha256} from ${pin.releaseTag}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { downloadPinnedInventory };
