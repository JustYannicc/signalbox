import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { finalizeMachineProgramInventory } from "./prepare.mjs";

const imageId = `sha256:${"1".repeat(64)}`;
const digest = `sha256:${"2".repeat(64)}`;
const revision = "3".repeat(40);
const captureSha256 = NodeCrypto.createHash("sha256")
  .update(NodeFS.readFileSync(new URL("./capture.mjs", import.meta.url)))
  .digest("hex");

function snapshot(overrides = {}) {
  return {
    format: "signalbox-machine-files-capture-v1",
    complete: true,
    entryCount: 1,
    sourceImageId: imageId,
    sourceRevision: revision,
    captureSha256,
    platform: "linux/amd64",
    path: ["/usr/bin", "/bin"],
    excludedRoots: ["/proc"],
    entries: [
      {
        path: "/",
        type: "directory",
        size: "4096",
        nlink: "1",
        atimeNs: "1",
        mtimeNs: "2",
        ctimeNs: "3",
        mode: 0o755,
        uid: 0,
        gid: 0,
      },
    ],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    imageRepository: "ghcr.io/justyannicc/signalbox-runner",
    imageRef: `ghcr.io/justyannicc/signalbox-runner@${digest}`,
    sourceImageId: imageId,
    sourceRevision: revision,
    platform: "linux/amd64",
    dockerfile: "apps/server/src/signalbox/runner/image/Dockerfile",
    captureSha256,
    ...overrides,
  };
}

describe("finalizeMachineProgramInventory", () => {
  it("pins the capture to the published image and retains its provenance", () => {
    const inventory = finalizeMachineProgramInventory(snapshot(), input());
    expect(inventory.imageRef).toBe(`ghcr.io/justyannicc/signalbox-runner@${digest}`);
    expect(inventory.imageDigest).toBe(digest);
    expect(inventory.provenance).toEqual({
      sourceRevision: revision,
      sourceImageId: imageId,
      dockerfile: "apps/server/src/signalbox/runner/image/Dockerfile",
      captureSha256,
    });
    expect(inventory.entries).toHaveLength(1);
  });

  it("rejects a capture from a different local build image", () => {
    expect(() =>
      finalizeMachineProgramInventory(
        snapshot(),
        input({ sourceImageId: `sha256:${"5".repeat(64)}` }),
      ),
    ).toThrow("Capture does not belong to the selected build image");
  });

  it("rejects a snapshot created by a different capture source", () => {
    expect(() =>
      finalizeMachineProgramInventory(snapshot({ captureSha256: "5".repeat(64) }), input()),
    ).toThrow("Capture script hash does not match the source file");
  });

  it("rejects entries under live-only roots", () => {
    const capturedProc = {
      path: "/proc",
      type: "directory",
      size: "0",
      nlink: "1",
      atimeNs: "1",
      mtimeNs: "2",
      ctimeNs: "3",
      mode: 0o555,
      uid: 0,
      gid: 0,
    };
    const root = snapshot().entries[0];
    expect(() =>
      finalizeMachineProgramInventory(
        snapshot({ entries: [root, capturedProc], entryCount: 2 }),
        input(),
      ),
    ).toThrow("Capture includes a live-only path: /proc");
  });

  it("rejects a mutable or mismatched image reference", () => {
    expect(() =>
      finalizeMachineProgramInventory(
        snapshot(),
        input({ imageRef: "ghcr.io/justyannicc/signalbox-runner:nightly" }),
      ),
    ).toThrow("Published image reference must be pinned");
  });

  it("rejects an incomplete root capture", () => {
    const incomplete = snapshot({ entries: [], entryCount: 0 });
    NodeAssert.throws(
      () => finalizeMachineProgramInventory(incomplete, input()),
      /image root directory/,
    );
  });
});
