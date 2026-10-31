import { describe, expect, it, vi } from "vite-plus/test";
import {
  claudeEnvironmentPackageModuleName,
  claudePreparedModuleName,
  claudePreparedWorkerModules,
  createClaudePreparedImports,
  type ClaudePreparedPlan,
  type ClaudePreparedRelease,
} from "./claudePreparedModules.ts";

const hash = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

function release(plan: ClaudePreparedPlan): ClaudePreparedRelease {
  return {
    artifact: { artifactRef: `sha256:${"a".repeat(64)}` },
    plan,
  };
}

describe("Claude prepared WorkerLoader modules", () => {
  it("maps the selected SDK, CLI, and environment package source to pinned names", async () => {
    const sdkSource =
      "export function initialize(){return {query(){},forkSession(){},getSubagentMessages(){}}}";
    const cliSource = "export function launch(){}";
    const wsSource = "export default { WebSocket: class WebSocket {} }";
    const plan: ClaudePreparedPlan = {
      preparedModules: {
        "sdk/sdk.mjs": {
          component: "sdk",
          name: "sdk.mjs",
          path: "sdk/sdk.mjs",
          bytes: sdkSource.length,
          sha256: await hash(sdkSource),
          type: "js",
        },
        "cli/main.js": {
          component: "cli",
          name: "main.js",
          path: "cli/main.js",
          bytes: cliSource.length,
          sha256: await hash(cliSource),
          type: "js",
        },
      },
      environmentPackageModules: { ws: { bytes: wsSource.length, sha256: await hash(wsSource) } },
      initialize: { module: "sdk/sdk.mjs", export: "initialize" },
      main: { module: "cli/main.js", export: "launch" },
      cli: { version: "2.1.0" },
      sdk: { version: "0.3.276" },
    };

    const modules = await claudePreparedWorkerModules(release(plan), { ws: wsSource });

    expect(Object.keys(modules).sort()).toEqual([
      claudePreparedModuleName("cli/main.js"),
      claudeEnvironmentPackageModuleName("ws"),
      claudePreparedModuleName("sdk/sdk.mjs"),
    ]);
    expect(modules[claudePreparedModuleName("sdk/sdk.mjs")]).toMatchObject({
      preparedReleaseAsset: {
        moduleKey: "sdk/sdk.mjs",
        path: "sdk/sdk.mjs",
        sha256: await hash(sdkSource),
      },
    });
    expect(modules[claudeEnvironmentPackageModuleName("ws")]).toEqual({ js: wsSource });
  });

  it("imports the SDK initializer and CLI module without launching the CLI", async () => {
    const plan: ClaudePreparedPlan = {
      preparedModules: {},
      environmentPackageModules: {},
      initialize: { module: "sdk/sdk.mjs", export: "initialize" },
      main: { module: "cli/main.js", export: "launch" },
      cli: { version: "2.1.0" },
      sdk: { version: "0.3.276" },
    };
    const launch = vi.fn();
    const importer = vi.fn(async (specifier: string) => {
      if (specifier === `./${claudePreparedModuleName("sdk/sdk.mjs")}`)
        return {
          initialize: () => ({ query() {}, forkSession() {}, getSubagentMessages() {} }),
        };
      if (specifier === `./${claudePreparedModuleName("cli/main.js")}`) return { launch };
      throw new Error(`Unexpected prepared module: ${specifier}`);
    });
    const imports = createClaudePreparedImports(importer);

    const inspected = await imports.inspect(plan, new AbortController().signal);

    expect(importer.mock.calls.map(([specifier]) => specifier)).toEqual([
      `./${claudePreparedModuleName("sdk/sdk.mjs")}`,
      `./${claudePreparedModuleName("cli/main.js")}`,
    ]);
    expect(inspected).toMatchObject({
      sdk: { version: "0.3.276" },
      cli: { version: "2.1.0", launch: true },
      nativeStarted: false,
    });
    expect(launch).not.toHaveBeenCalled();
  });
});
