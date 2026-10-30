import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect, test } from "vite-plus/test";
import { createClaudePreparedImports } from "./fixture/claudePreparedModules.ts";
import { claudePreparedModuleSpecifier } from "./fixture/claudePreparedModules.ts";
import { loadDeploy3ClaudeAssets } from "./claudeAssets.ts";
import { inspectDeploy3AssetRoot } from "./inspectAssets.ts";
import { syntheticAssets } from "./syntheticAssets.fixture.ts";
import { writeReleaseDeploymentAssets } from "../../harnessReleases/deploymentAssets.ts";
import { openHarnessReleaseDeployment } from "../../../src/harnessReleases/HarnessReleaseDeployment.ts";

test("qualification assets retain pending eligibility and both exact graphs", async () => {
  const f = await syntheticAssets();
  try {
    const loaded = await loadDeploy3ClaudeAssets(f.input, f.binding);
    expect(loaded.purpose).toBe("qualification");
    expect(loaded.eligibility.baseline.status).toBe("pending");
    expect(loaded.eligibility.hooks.status).toBe("pending");
    expect(loaded.baseline.plan.preparedModules).toEqual(
      f.input.assets.baselinePin.preparedModules,
    );
    expect(Object.keys(loaded.hooks.plan.workerEntries)).toEqual(["hooks-worker"]);
    expect(loaded.releaseVariants.ledger.listProofs("claude-code", "baseline")).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("pending package refuses I/O and cannot enter the release reader", async () => {
  await expect(
    loadDeploy3ClaudeAssets(
      {
        schema: "sb1070/deploy3-claude-assets/v2",
        ownerIssue: 1072,
        assets: { status: "awaiting-package", missing: ["owner pins"] },
      },
      {
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
      },
    ),
  ).rejects.toThrow("AWAITING_PACKAGE");
  const f = await syntheticAssets();
  try {
    await expect(
      loadDeploy3ClaudeAssets(
        { ...f.input, assets: { ...f.input.assets, purpose: "release" } },
        f.binding,
      ),
    ).rejects.toThrow("PURPOSE_MISMATCH");
  } finally {
    await f.dispose();
  }
});

test("changed baseline graph, asset bytes, project and metadata fail closed", async () => {
  const f = await syntheticAssets();
  try {
    const key = Object.keys(f.input.assets.baselinePin.preparedModules)[0]!;
    const changed = {
      ...f.input,
      assets: {
        ...f.input.assets,
        baselinePin: {
          ...f.input.assets.baselinePin,
          preparedModules: {
            ...f.input.assets.baselinePin.preparedModules,
            [key]: { ...f.input.assets.baselinePin.preparedModules[key]!, sha256: "e".repeat(64) },
          },
        },
      },
    };
    await expect(loadDeploy3ClaudeAssets(changed, f.binding)).rejects.toThrow(
      "BASELINE_MODULES_MISMATCH",
    );
    await expect(
      loadDeploy3ClaudeAssets(
        { ...f.input, assets: { ...f.input.assets, projectId: "other" } },
        f.binding,
      ),
    ).rejects.toThrow("PROJECT_MISMATCH");
    let reads = 0;
    await expect(
      loadDeploy3ClaudeAssets(f.input, {
        fetch: (request) =>
          new URL(request.url).pathname.includes("/deployments/") && ++reads > 1
            ? Promise.resolve(new Response("changed"))
            : f.binding.fetch(request),
      }),
    ).rejects.toThrow("PIN_MISMATCH");
    const index = f.deployment.assets[0]!;
    const pin = index.files["cli/release.js"]!.chunks[0]!;
    await NodeFSP.chmod(NodePath.join(f.assetsDirectory, pin.path), 0o600);
    await NodeFSP.appendFile(NodePath.join(f.assetsDirectory, pin.path), "changed");
    await expect(loadDeploy3ClaudeAssets(f.input, f.binding)).rejects.toThrow("PIN_MISMATCH");
  } finally {
    await f.dispose();
  }
});

test("inventory includes all assets in the combined Worker", async () => {
  const f = await syntheticAssets();
  try {
    const before = await inspectDeploy3AssetRoot(f.assetsDirectory, f.input);
    await NodeFSP.mkdir(NodePath.join(f.assetsDirectory, "programs"));
    const file = await NodeFSP.open(
      NodePath.join(f.assetsDirectory, "programs/oversized.wasm"),
      "w",
    );
    try {
      await file.truncate(25 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }
    expect(before.inventory.files).toBeGreaterThan(1);
    await expect(inspectDeploy3AssetRoot(f.assetsDirectory, f.input)).rejects.toThrow(
      "ASSET_TOO_LARGE",
    );
  } finally {
    await f.dispose();
  }
});

test("qualification preserves open findings without promoting the corpus to a release", async () => {
  const f = await syntheticAssets();
  try {
    const finding = {
      schemaVersion: 1 as const,
      status: "open" as const,
      sources: [
        { name: "synthetic-input.js", bytes: 37, sha256: "e".repeat(64), sourceUtf16Length: 37 },
      ],
      missingBuiltins: ["node:synthetic-unavailable"],
      unknownBuiltinSpecifiers: [],
      importAmbiguities: [],
      calls: [],
      callAmbiguities: [],
    };
    const deployment = {
      ...f.deployment,
      releasable: false,
      ledger: f.deployment.ledger.map((entry) => ({ ...entry, openFindings: [finding] })),
    };
    const written = await writeReleaseDeploymentAssets({
      directory: f.assetsDirectory,
      deployment,
    });
    const loaded = await loadDeploy3ClaudeAssets(
      { ...f.input, assets: { ...f.input.assets, metadata: written.pin } },
      f.binding,
    );
    expect(loaded.releasable).toBe(false);
    expect(loaded.openFindings).toEqual({ baseline: [finding], hooks: [finding] });
    expect(loaded.releaseVariants.ledger.getOpenFindings("claude-code", "baseline")).toEqual([
      finding,
    ]);
    expect(loaded.eligibility.baseline.status).toBe("pending");
    expect(() =>
      openHarnessReleaseDeployment(
        { ...deployment, purpose: "release", releasable: true },
        f.binding,
        deployment.projectId,
      ),
    ).toThrow("HARNESS_DEPLOYMENT_OPEN_FINDINGS");
  } finally {
    await f.dispose();
  }
});

test("published synthetic CLI and SDK modules can be imported through their selected public plan", async () => {
  const f = await syntheticAssets();
  try {
    const loaded = await loadDeploy3ClaudeAssets(f.input, f.binding);
    for (const selected of [loaded.baseline, loaded.hooks]) {
      const release =
        loaded.releaseVariants.catalog[selected === loaded.baseline ? "baseline" : "hooks"]
          .fullArtifact;
      const imports = createClaudePreparedImports(async (specifier) => {
        const entry = Object.entries(selected.plan.preparedModules).find(
          ([name]) => claudePreparedModuleSpecifier(name) === specifier,
        );
        if (!entry) throw new Error("Synthetic module missing from selected plan");
        const bytes = await loaded.source.read(release.artifactRef, entry[1].path);
        return import(
          /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`
        );
      });
      const observed = await imports.inspect(selected.plan, new AbortController().signal);
      expect(observed.cli.launch).toBe(true);
      expect(observed.sdk.exports).toContain("query");
      expect(observed.nativeStarted).toBe(false);
      const sdk = await imports.loadSdk(selected.plan, new AbortController().signal);
      expect(() => Reflect.apply(sdk.query, undefined, [])).toThrow("Synthetic SDK cannot start");
    }
  } finally {
    await f.dispose();
  }
});
