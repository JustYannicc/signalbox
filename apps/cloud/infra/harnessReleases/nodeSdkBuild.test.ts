import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { decodeSdkManifest } from "../../src/harness/HarnessReleaseManifests.ts";
import { createNodeBridge, installNodeBridge } from "../../src/isolate/NodeBridge.ts";
import { buildNodeSdk, claudeAgentSdkPackage, sdkFixture } from "./nodeSdkBuildFixture.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("Claude Agent SDK bundle builder", () => {
  it("builds a closed module graph behind the bridge-bound initialize export", async () => {
    const fixture = await sdkFixture(
      `
      import fs from "node:fs";
      import { answer } from "test-dependency";
      export const version = fs.readFileSync("/sdk-version", "utf8");
      export const dependency = answer();
    `,
      temporary,
    );
    const output = NodePath.join(fixture.directory, "component");
    const built = await buildNodeSdk({
      source: fixture.sdk,
      dependencies: [fixture.dependency],
      nodeModulesRoot: NodePath.join(fixture.directory, "node_modules"),
      output,
    });
    const rawManifest: unknown = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output, "manifest.json"), "utf8"),
    );
    const manifest = decodeSdkManifest(rawManifest);
    const moduleBytes = await NodeFSP.readFile(NodePath.join(output, manifest.mainModule));
    const moduleMap = JSON.parse(
      await NodeFSP.readFile(NodePath.join(output, "module-map.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      release: { provider: "agent-sdk", name: claudeAgentSdkPackage, version: "0.0.1" },
      mainModule: "sdk.mjs",
      initializeExport: "initialize",
      requiredHostModules: ["fs"],
    });
    expect(rawManifest).toMatchObject({ assets: {} });
    expect(moduleMap[manifest.mainModule]).toMatchObject({ path: "sdk.mjs", type: "js" });
    expect(manifest.modules[manifest.mainModule]?.sha256).toBe(
      NodeCrypto.createHash("sha256").update(moduleBytes).digest("hex"),
    );
    expect(built.sourceFiles.map(({ packageName, path }) => `${packageName}/${path}`)).toEqual([
      `${claudeAgentSdkPackage}/sdk.mjs`,
      "test-dependency/index.js",
    ]);

    const sdkModule: unknown = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${moduleBytes.toString("base64")}`
    );
    expect(Object.keys(sdkModule as object)).toEqual(["initialize"]);
    const initialize = Reflect.get(sdkModule as object, "initialize");
    expect(typeof initialize).toBe("function");

    const reads: string[] = [];
    const firstBridge = installNodeBridge(
      createNodeBridge({
        fs: {
          readFileSync(path: string) {
            reads.push(path);
            return "bridge-value";
          },
        },
      }),
    );
    let first: Record<string, unknown> | undefined;
    try {
      first = (initialize as () => Record<string, unknown>)();
    } finally {
      firstBridge.restore();
    }
    expect(first).toMatchObject({ version: "bridge-value", dependency: 42 });

    const secondBridge = installNodeBridge(
      createNodeBridge({
        fs: {
          readFileSync(path: string) {
            reads.push(path);
            return "second-bridge-value";
          },
        },
      }),
    );
    try {
      const second = (initialize as () => Record<string, unknown>)();
      expect(second).toMatchObject({ version: "second-bridge-value", dependency: 42 });
    } finally {
      secondBridge.restore();
    }
    expect(first).toMatchObject({ version: "bridge-value", dependency: 42 });
    expect(reads).toEqual(["/sdk-version", "/sdk-version"]);
  });

  it("rejects an imported dependency without an integrity-pinned source", async () => {
    const fixture = await sdkFixture(
      'import { read } from "not-installed"; export const value = read();',
      temporary,
    );
    const unpinned = NodePath.join(fixture.directory, "node_modules", "not-installed");
    await NodeFSP.mkdir(unpinned, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(unpinned, "package.json"),
      JSON.stringify({ name: "not-installed", version: "1.0.0", main: "index.js", type: "module" }),
    );
    await NodeFSP.writeFile(NodePath.join(unpinned, "index.js"), "export const read = () => 1;");
    await expect(
      buildNodeSdk({
        source: fixture.sdk,
        nodeModulesRoot: NodePath.join(fixture.directory, "node_modules"),
        output: NodePath.join(fixture.directory, "rejected"),
      }),
    ).rejects.toThrow("NODE_SDK_UNDECLARED_DEPENDENCY_INPUT");
    await expect(NodeFSP.stat(NodePath.join(fixture.directory, "rejected"))).rejects.toThrow();
  });

  it("rejects a changed installed SDK payload against its pinned npm archive", async () => {
    const fixture = await sdkFixture("export const value = true;", temporary);
    await NodeFSP.writeFile(
      NodePath.join(fixture.sdk.root, "sdk.mjs"),
      "export const value = false;",
    );

    await expect(
      buildNodeSdk({
        source: fixture.sdk,
        output: NodePath.join(fixture.directory, "drifted"),
      }),
    ).rejects.toThrow("CLAUDE_SDK_SOURCE_ARCHIVE_MISMATCH");
    await expect(NodeFSP.stat(NodePath.join(fixture.directory, "drifted"))).rejects.toThrow();
  });

  it("rejects a changed npm tarball before producing a component", async () => {
    const fixture = await sdkFixture("export const value = true;", temporary);
    await NodeFSP.appendFile(fixture.sdk.tarball, "modified");

    await expect(
      buildNodeSdk({
        source: fixture.sdk,
        output: NodePath.join(fixture.directory, "tampered"),
      }),
    ).rejects.toThrow("CLAUDE_SDK_NPM_INTEGRITY_MISMATCH");
    await expect(NodeFSP.stat(NodePath.join(fixture.directory, "tampered"))).rejects.toThrow();
  });
});
