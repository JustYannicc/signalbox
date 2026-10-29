"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { downloadPinnedInventory } = require("./runner-machine-inventory.cjs");
const { publishInventory } = require("./publish-runner-machine-inventory.cjs");
const {
  releaseTagForDigest,
  sha256,
  verifyInventoryBytes,
} = require("./runner-machine-inventory-lib.cjs");

const sourceRevision = "1".repeat(40);
const imageDigest = `sha256:${"a".repeat(64)}`;
const imageRef = `ghcr.io/justyannicc/signalbox-runner@${imageDigest}`;
const sourceImageId = `sha256:${"b".repeat(64)}`;
const captureSha256 = "c".repeat(64);
const inventory = {
  format: "signalbox-machine-files-v1",
  imageRef,
  imageDigest,
  platform: "linux/amd64",
  provenance: {
    sourceRevision,
    sourceImageId,
    dockerfile: "apps/server/src/signalbox/runner/image/Dockerfile",
    captureSha256,
  },
  imageContent: { imageDigest, captureSha256 },
};
const bytes = Buffer.from(JSON.stringify(inventory));
const pin = {
  schemaVersion: 1,
  repository: "JustYannicc/signalbox",
  releaseTag: releaseTagForDigest(imageDigest),
  assetName: "runner.json",
  sha256: sha256(bytes),
  imageRef,
  sourceImageId,
  sourceRevision,
  platform: "linux/amd64",
  captureSha256,
  sourceArtifact: {
    workflow: ".github/workflows/runner-image.yml",
    runId: "40658723985",
    runAttempt: 1,
    artifactId: "12802373209",
    artifactName: "runner-machine-files-40658723985-1",
  },
};

function releaseNotFound() {
  return Object.assign(new Error("Command failed: gh api releases/tags/missing"), {
    stderr: "gh: Not Found (HTTP 404)\n",
  });
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runner-inventory-test-"));
}

test("verifies exact inventory bytes and captured image provenance", () => {
  assert.deepEqual(verifyInventoryBytes(bytes, pin), inventory);
});

test("rejects inventory bytes that do not match the pinned hash", () => {
  assert.throws(() => verifyInventoryBytes(Buffer.from("{}"), pin), /SHA-256 mismatch/);
});

test("rejects an image digest mismatch even when the bytes hash is updated", () => {
  const changed = Buffer.from(
    JSON.stringify({ ...inventory, imageDigest: `sha256:${"d".repeat(64)}` }),
  );
  assert.throws(
    () => verifyInventoryBytes(changed, { ...pin, sha256: sha256(changed) }),
    /image reference/,
  );
});

test("downloads the pinned release asset only after release metadata and bytes match", () => {
  const directory = tempDirectory();
  try {
    const outputPath = path.join(directory, "out", "runner.json");
    const release = {
      tag_name: pin.releaseTag,
      name: "Runner machine files presentation title",
      draft: false,
      assets: [{ name: "runner.json" }],
    };
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (args[0] === "api") return JSON.stringify(release);
      if (args[0] === "release" && args[1] === "download") {
        const target = args[args.indexOf("--dir") + 1];
        fs.writeFileSync(path.join(target, "runner.json"), bytes);
        return "";
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    };

    const result = downloadPinnedInventory({ outputPath, pin, runGh });
    assert.equal(fs.readFileSync(outputPath).toString("utf8"), bytes.toString("utf8"));
    assert.equal(result.sha256, pin.sha256);
    assert.equal(calls[0][0], "api");
    assert.equal(calls[1][0], "release");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fails closed when the pinned release or asset is absent", () => {
  const directory = tempDirectory();
  try {
    assert.throws(
      () =>
        downloadPinnedInventory({
          outputPath: path.join(directory, "runner.json"),
          pin,
          runGh: () => {
            throw releaseNotFound();
          },
        }),
      /release .* is missing/,
    );

    assert.throws(
      () =>
        downloadPinnedInventory({
          outputPath: path.join(directory, "runner.json"),
          pin,
          runGh: (args) =>
            args[0] === "api"
              ? JSON.stringify({ tag_name: pin.releaseTag, draft: false, assets: [] })
              : "",
        }),
      /has no runner.json asset/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("creates a missing digest release and verifies its published bytes", () => {
  const directory = tempDirectory();
  try {
    const inventoryPath = path.join(directory, "runner.json");
    fs.writeFileSync(inventoryPath, bytes);
    let created = false;
    let downloaded = false;
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (args[0] === "api") {
        if (!created) throw releaseNotFound();
        return JSON.stringify({
          tag_name: pin.releaseTag,
          draft: false,
          assets: [{ name: "runner.json" }],
        });
      }
      if (args[0] === "release" && args[1] === "create") {
        assert.equal(args[2], pin.releaseTag);
        assert.equal(args[3], inventoryPath);
        assert.equal(args[args.indexOf("--target") + 1], sourceRevision);
        created = true;
        return "";
      }
      if (args[0] === "release" && args[1] === "download") {
        downloaded = true;
        fs.writeFileSync(path.join(args[args.indexOf("--dir") + 1], "runner.json"), bytes);
        return "";
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    };

    assert.deepEqual(
      publishInventory({
        inventoryPath,
        repository: pin.repository,
        imageRef,
        sourceRevision,
        sourceImageId,
        platform: "linux/amd64",
        runGh,
      }),
      { tag: pin.releaseTag, sha256: pin.sha256 },
    );
    assert.equal(created, true);
    assert.equal(downloaded, true);
    assert.equal(calls.filter((args) => args[1] === "create").length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not publish after authorization or server errors during release lookup", () => {
  for (const status of [401, 403, 500]) {
    const directory = tempDirectory();
    try {
      const inventoryPath = path.join(directory, "runner.json");
      fs.writeFileSync(inventoryPath, bytes);
      const failure = Object.assign(new Error("Command failed: gh api releases/tags/missing"), {
        stderr: `gh: Request failed (HTTP ${status})\n`,
      });
      const calls = [];
      assert.throws(
        () =>
          publishInventory({
            inventoryPath,
            repository: pin.repository,
            imageRef,
            sourceRevision,
            sourceImageId,
            platform: "linux/amd64",
            runGh: (args) => {
              calls.push(args);
              throw failure;
            },
          }),
        (error) => error === failure,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "api");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("fails when release creation fails and the release is still missing", () => {
  const directory = tempDirectory();
  try {
    const inventoryPath = path.join(directory, "runner.json");
    fs.writeFileSync(inventoryPath, bytes);
    const failure = new Error("release creation denied");
    assert.throws(
      () =>
        publishInventory({
          inventoryPath,
          repository: pin.repository,
          imageRef,
          sourceRevision,
          sourceImageId,
          platform: "linux/amd64",
          runGh: (args) => {
            if (args[0] === "api") throw releaseNotFound();
            if (args[0] === "release" && args[1] === "create") throw failure;
            throw new Error(`Unexpected gh call: ${args.join(" ")}`);
          },
        }),
      (error) => error === failure,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts a concurrent immutable release only after its asset hash matches", () => {
  const directory = tempDirectory();
  try {
    const inventoryPath = path.join(directory, "runner.json");
    fs.writeFileSync(inventoryPath, bytes);
    const release = {
      tag_name: pin.releaseTag,
      draft: false,
      assets: [{ name: "runner.json" }],
    };
    let apiCalls = 0;
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (args[0] === "api") {
        apiCalls++;
        if (apiCalls === 1) throw releaseNotFound();
        return JSON.stringify(release);
      }
      if (args[0] === "release" && args[1] === "create") throw new Error("release already exists");
      if (args[0] === "release" && args[1] === "download") {
        fs.writeFileSync(path.join(args[args.indexOf("--dir") + 1], "runner.json"), bytes);
        return "";
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    };

    const result = publishInventory({
      inventoryPath,
      repository: pin.repository,
      imageRef,
      sourceRevision,
      sourceImageId,
      platform: "linux/amd64",
      runGh,
    });
    assert.equal(result.tag, pin.releaseTag);
    assert.equal(result.sha256, pin.sha256);
    assert.equal(
      calls.some((args) => args[0] === "release" && args[1] === "upload"),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to replace an existing digest release asset with different bytes", () => {
  const directory = tempDirectory();
  try {
    const inventoryPath = path.join(directory, "runner.json");
    fs.writeFileSync(inventoryPath, bytes);
    const release = {
      tag_name: pin.releaseTag,
      draft: false,
      assets: [{ name: "runner.json" }],
    };
    const conflictingBytes = Buffer.from(`${bytes.toString("utf8")} `);
    const calls = [];
    const runGh = (args) => {
      calls.push(args);
      if (args[0] === "api") return JSON.stringify(release);
      if (args[0] === "release" && args[1] === "download") {
        fs.writeFileSync(
          path.join(args[args.indexOf("--dir") + 1], "runner.json"),
          conflictingBytes,
        );
        return "";
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    };

    assert.throws(
      () =>
        publishInventory({
          inventoryPath,
          repository: pin.repository,
          imageRef,
          sourceRevision,
          sourceImageId,
          platform: "linux/amd64",
          runGh,
        }),
      /Immutable Runner inventory release conflict/,
    );
    assert.equal(
      calls.some((args) => args[0] === "release" && args[1] === "upload"),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
