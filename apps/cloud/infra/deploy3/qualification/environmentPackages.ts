// @effect-diagnostics nodeBuiltinImport:off - This standalone Node build adapter prepares and verifies local deployment files before Worker bundling.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ClaudeReleasePlan } from "../../../src/harness/HarnessReleasePlan.ts";
import type { FixtureFilePin } from "./bundleInput.ts";

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Keeps the exact package sources paired with both prepared Claude graphs. */
export async function prepareEnvironmentPackages(
  pins: Readonly<Record<string, typeof FixtureFilePin.Type>>,
  plans: readonly Pick<ClaudeReleasePlan, "environmentPackageModules">[],
) {
  const names = Object.keys(pins).sort();
  const contents = new Map<string, Uint8Array>();
  for (const plan of plans) {
    if (
      JSON.stringify(Object.keys(plan.environmentPackageModules).sort()) !== JSON.stringify(names)
    )
      throw new Error("DEPLOY3_CLAUDE_ENVIRONMENT_PACKAGE_SET_MISMATCH");
    for (const name of names) {
      const pin = pins[name]!;
      const expected = plan.environmentPackageModules[name]!;
      if (pin.bytes !== expected.bytes || pin.sha256 !== expected.sha256)
        throw new Error(`DEPLOY3_CLAUDE_ENVIRONMENT_PACKAGE_PIN_MISMATCH: ${name}`);
      if (!contents.has(name)) {
        const bytes = await NodeFSP.readFile(pin.path);
        if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256)
          throw new Error(`DEPLOY3_CHANGED_ENVIRONMENT_PACKAGE: ${name}`);
        contents.set(name, bytes);
      }
    }
  }
  const assets = Object.fromEntries(
    names.map((name) => {
      const pin = pins[name]!;
      return [
        name,
        { path: `qualifier/environment/${pin.sha256}.mjs`, bytes: pin.bytes, sha256: pin.sha256 },
      ];
    }),
  );
  return {
    assets,
    async write(directory: string) {
      if (!contents.size) return;
      await NodeFSP.mkdir(NodePath.join(directory, "qualifier/environment"));
      const written = new Set<string>();
      for (const [name, bytes] of contents) {
        const pin = assets[name]!;
        if (written.has(pin.path)) continue;
        await NodeFSP.writeFile(NodePath.join(directory, pin.path), bytes, { flag: "wx" });
        written.add(pin.path);
      }
    },
  };
}
