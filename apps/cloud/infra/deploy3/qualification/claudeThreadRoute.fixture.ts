// @effect-diagnostics nodeBuiltinImport:off - The local build writes the synthetic qualifier files a Workerd run serves.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import { CHILD_PROGRAM_PATHS } from "../../../src/computer/ChildProgramSet.ts";
import { buildCombinedFixture } from "./buildFixture.ts";
import { dataForDriver } from "./runnerTurn.fixture.ts";
import { syntheticAssets } from "./syntheticAssets.fixture.ts";
import { syntheticBundleInput } from "./syntheticBundle.fixture.ts";

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The real qualifier Worker and its assets, built from the synthetic release. Its program catalog
 * gains placeholder executables, because the product host refuses a seed without every child
 * program path.
 */
export async function syntheticQualifierBuild() {
  const assets = await syntheticAssets();
  try {
    const data = await Effect.runPromise(dataForDriver(ProviderDriverKind.make("claudeAgent")));
    const input = await syntheticBundleInput(assets, data);
    await buildCombinedFixture(input);
    const output = input.outputDirectory;
    const configPath = NodePath.join(output, "assets/qualifier/config.json");
    const config = JSON.parse(await NodeFSP.readFile(configPath, "utf8"));
    const seed = new TextEncoder().encode("#!/bin/sh\n");
    await NodeFSP.mkdir(NodePath.join(output, "assets/qualifier/seed"));
    for (const [name, path] of Object.entries(CHILD_PROGRAM_PATHS)) {
      const asset = `qualifier/seed/${name}`;
      await NodeFSP.writeFile(NodePath.join(output, "assets", asset), seed);
      const pin = { bytes: seed.length, sha256: sha256(seed) };
      config.programCatalog.files[path] = { ...pin, mode: 0o755, uid: 1000, gid: 1000 };
      config.programPaths[path] = { ...pin, path: asset };
    }
    const bytes = new TextEncoder().encode(JSON.stringify(config));
    await NodeFSP.writeFile(configPath, bytes);
    return {
      output,
      runId: String(config.runId),
      workerName: String(config.workerName),
      configSha256: sha256(bytes),
      dispose: assets.dispose,
    };
  } catch (cause) {
    await assets.dispose();
    throw cause;
  }
}
