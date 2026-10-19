// @effect-diagnostics nodeBuiltinImport:off - tests run the native installer against owned temporary files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { BOXD_PROOF_SOURCE_INSTALL, BOXD_PROOF_BOOTSTRAP_INSTALL } from "./NativeInstall.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const python = "/usr/bin/python3";
const crossDevice = String.raw`
import errno, os

rename, replace = os.rename, os.replace

def cross_device(operation):
    def checked(source, target, *args, **kwargs):
        if os.path.dirname(source) != os.path.dirname(target):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return operation(source, target, *args, **kwargs)
    return checked

os.rename = cross_device(rename)
os.replace = cross_device(replace)
`;

describe("proof native source installation", () => {
  it.each([false, true])("installs the exact bytes with cross-device rename=%s", async (exdev) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "boxd-source-install-"));
    const staging = NodePath.join(root, "uploaded-runner");
    const artifact = NodePath.join(root, "installed", "command-runner.mjs");
    const bytes = new Uint8Array([0, 255, 65, 10]);
    try {
      await NodeFSP.mkdir(NodePath.dirname(artifact));
      await NodeFSP.writeFile(staging, bytes, { mode: 0o600 });
      await NodeFSP.writeFile(artifact, "old artifact");
      await execute(python, [
        "-c",
        (exdev ? crossDevice : "") + BOXD_PROOF_SOURCE_INSTALL,
        staging,
        artifact,
        "owned-source",
      ]);

      expect(new Uint8Array(await NodeFSP.readFile(artifact))).toEqual(bytes);
      expect((await NodeFSP.stat(artifact)).mode & 0o777).toBe(0o644);
      expect(
        await NodeFSP.readFile(NodePath.join(NodePath.dirname(artifact), "base-marker"), "utf8"),
      ).toBe("owned-source");
      await expect(NodeFSP.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("installs callback config privately and preserves receipt bytes across filesystems", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "boxd-bootstrap-install-"));
    const config = NodePath.join(root, "run", "runner.json");
    const receipt = NodePath.join(root, "run", "workspace.json");
    const stagedConfig = NodePath.join(root, "config-upload");
    const stagedReceipt = NodePath.join(root, "receipt-upload");
    try {
      await NodeFSP.writeFile(stagedConfig, "private callback configuration", { mode: 0o644 });
      await NodeFSP.writeFile(stagedReceipt, "workspace receipt");
      await execute(python, [
        "-c",
        crossDevice + BOXD_PROOF_BOOTSTRAP_INSTALL,
        stagedConfig,
        config,
        stagedReceipt,
        receipt,
      ]);
      expect(await NodeFSP.readFile(config, "utf8")).toBe("private callback configuration");
      expect((await NodeFSP.stat(config)).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readFile(receipt, "utf8")).toBe("workspace receipt");
      expect((await NodeFSP.stat(receipt)).mode & 0o777).toBe(0o644);
      await expect(NodeFSP.stat(stagedConfig)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.stat(stagedReceipt)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await NodeFSP.readdir(NodePath.dirname(config))).sort()).toEqual([
        "runner.json",
        "workspace.json",
      ]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not mark the source prepared when the upload is missing", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "boxd-source-missing-"));
    try {
      await expect(
        execute(python, [
          "-c",
          BOXD_PROOF_SOURCE_INSTALL,
          NodePath.join(root, "missing"),
          NodePath.join(root, "artifact"),
          "owned-source",
        ]),
      ).rejects.toMatchObject({ code: 1 });
      await expect(NodeFSP.stat(NodePath.join(root, "base-marker"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(NodeFSP.stat(NodePath.join(root, "artifact"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
