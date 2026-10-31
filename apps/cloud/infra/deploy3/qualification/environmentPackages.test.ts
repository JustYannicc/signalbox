import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, test } from "vite-plus/test";
import { fixtureHash } from "./syntheticAssets.fixture.ts";
import { prepareEnvironmentPackages } from "./environmentPackages.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deploy3-environment-"));
  const bytes = Buffer.from("export const syntheticPackage = true;\n");
  const path = NodePath.join(root, "package.mjs");
  await NodeFSP.writeFile(path, bytes);
  const pin = { path, bytes: bytes.length, sha256: fixtureHash(bytes) };
  const descriptor = { bytes: pin.bytes, sha256: pin.sha256 };
  return {
    root,
    bytes,
    pin,
    descriptor,
    dispose: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

test("exact package sources are checked against both variants and stored once per hash", async () => {
  const f = await fixture();
  try {
    const plan = { environmentPackageModules: { ws: f.descriptor, "node-fetch": f.descriptor } };
    const prepared = await prepareEnvironmentPackages({ ws: f.pin, "node-fetch": f.pin }, [
      plan,
      plan,
    ]);
    const assets = NodePath.join(f.root, "assets");
    await NodeFSP.mkdir(NodePath.join(assets, "qualifier"), { recursive: true });
    await prepared.write(assets);
    expect(await NodeFSP.readFile(NodePath.join(assets, prepared.assets.ws!.path))).toEqual(
      f.bytes,
    );
    expect(await NodeFSP.readdir(NodePath.join(assets, "qualifier/environment"))).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("different variant metadata, missing package and changed source cannot be assembled", async () => {
  const f = await fixture();
  try {
    const plan = { environmentPackageModules: { ws: f.descriptor } };
    await expect(
      prepareEnvironmentPackages({ ws: f.pin }, [
        plan,
        {
          environmentPackageModules: { ws: { ...f.descriptor, sha256: "e".repeat(64) } },
        },
      ]),
    ).rejects.toThrow("PACKAGE_PIN_MISMATCH");
    await expect(prepareEnvironmentPackages({}, [plan, plan])).rejects.toThrow(
      "PACKAGE_SET_MISMATCH",
    );
    await NodeFSP.appendFile(f.pin.path, "changed");
    await expect(prepareEnvironmentPackages({ ws: f.pin }, [plan, plan])).rejects.toThrow(
      "CHANGED_ENVIRONMENT_PACKAGE",
    );
  } finally {
    await f.dispose();
  }
});
