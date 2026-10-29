import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createNodeBridge, installNodeBridge } from "../../src/isolate/NodeBridge.ts";
import { createNodeModule } from "../../src/isolate/NodeModule.ts";
import { rewriteClaudeSdkCreateRequire } from "./claudeSdkCreateRequire.ts";
import { buildNodeSdk, sdkFixture } from "./nodeSdkBuildFixture.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("Claude SDK createRequire bundling", () => {
  it("bundles static createRequire dependencies into the bridge-bound initializer", async () => {
    const fixture = await sdkFixture(
      `
        import { createRequire } from "node:module";
        const sdkRequire = createRequire(import.meta.url);
        export const dependency = sdkRequire("test-dependency").answer();
      `,
      temporary,
    );
    const output = NodePath.join(fixture.directory, "create-require-component");
    const built = await buildNodeSdk({
      source: fixture.sdk,
      dependencies: [fixture.dependency],
      nodeModulesRoot: NodePath.join(fixture.directory, "node_modules"),
      output,
      transformSource: (source) => rewriteClaudeSdkCreateRequire(source),
    });
    const bytes = await NodeFSP.readFile(NodePath.join(output, "sdk.mjs"));
    const artifact: unknown = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${bytes.toString("base64")}`
    );
    const initialize = Reflect.get(artifact as object, "initialize");
    expect(typeof initialize).toBe("function");
    expect(built.manifest.requiredHostModules).toEqual(["module"]);
    expect(built.createRequireRewrites).toBe(1);
    const baseBridge = createNodeBridge({});
    const installed = installNodeBridge(createNodeBridge({ module: createNodeModule(baseBridge) }));
    try {
      expect((initialize as () => Record<string, unknown>)()).toMatchObject({ dependency: 42 });
    } finally {
      installed.restore();
    }
  });

  it("keeps fileURLToPath bases and delegates dynamic resolve to the prepared graph", async () => {
    const fixture = await sdkFixture(
      `
        import { createRequire as w6e } from "module";
        import { fileURLToPath as k6e } from "url";
        let $t = k6e(import.meta.url), In = w6e($t), Kr = (specifier) => In.resolve(specifier);
        export const dependency = In("test-dependency").answer();
        export const resolve = Kr;
        export const shadowed = (() => { const In = "local"; return In; })();
      `,
      temporary,
    );
    const output = NodePath.join(fixture.directory, "prepared-resolve-component");
    const built = await buildNodeSdk({
      source: fixture.sdk,
      dependencies: [fixture.dependency],
      nodeModulesRoot: NodePath.join(fixture.directory, "node_modules"),
      output,
      transformSource: (source) => rewriteClaudeSdkCreateRequire(source),
    });
    const bytes = await NodeFSP.readFile(NodePath.join(output, "sdk.mjs"));
    const artifact: unknown = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${bytes.toString("base64")}`
    );
    const initialize = Reflect.get(artifact as object, "initialize");
    expect(typeof initialize).toBe("function");

    const baseBridge = createNodeBridge({});
    const resolved: Array<{ readonly specifier: string; readonly referrer: string }> = [];
    const module = createNodeModule(baseBridge, undefined, (specifier, referrer) => {
      resolved.push({ specifier, referrer });
      return `/prepared/${specifier}`;
    });
    const installed = installNodeBridge(createNodeBridge({ module, url: NodeURL as object }));
    try {
      const initialized = (initialize as () => Record<string, unknown>)();
      expect(initialized.dependency).toBe(42);
      expect(initialized.shadowed).toBe("local");
      expect((initialized.resolve as (specifier: string) => string)("test-dependency")).toBe(
        "/prepared/test-dependency",
      );
    } finally {
      installed.restore();
    }

    expect(built.createRequireRewrites).toBe(1);
    expect(built.manifest.requiredHostModules).toEqual(["module", "url"]);
    expect(resolved).toEqual([{ specifier: "test-dependency", referrer: "/sdk.mjs" }]);
  });

  it("rejects an unpinned createRequire base even when static calls follow it", () => {
    expect(() =>
      rewriteClaudeSdkCreateRequire(`
        import { createRequire } from "node:module";
        const sdkRequire = createRequire(process.env.SDK_BASE);
        export const dependency = sdkRequire("test-dependency");
      `),
    ).toThrow("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
  });

  it("rejects a createRequire base with an intervening initializer", () => {
    expect(() =>
      rewriteClaudeSdkCreateRequire(`
        import { createRequire } from "node:module";
        import { fileURLToPath } from "node:url";
        let path = fileURLToPath(import.meta.url), ignored = touch(), sdkRequire = createRequire(path);
        export const dependency = sdkRequire("test-dependency");
      `),
    ).toThrow("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
  });

  it("drops an internal re-export of a createRequire instance", () => {
    const transformed = rewriteClaudeSdkCreateRequire(`
      import { createRequire } from "node:module";
      const internalRequire = createRequire(import.meta.url);
      const version = "fixture";
      export { internalRequire, version };
    `);

    expect(transformed.contents).toContain("export {version};");
    expect(transformed.contents).not.toContain("export {internalRequire");
  });

  it("rejects dynamic createRequire calls instead of leaving them outside the graph", async () => {
    const fixture = await sdkFixture(
      `
        import { createRequire } from "node:module";
        const sdkRequire = createRequire(import.meta.url);
        export const dependency = sdkRequire(process.env.DEPENDENCY);
      `,
      temporary,
    );

    await expect(
      buildNodeSdk({
        source: fixture.sdk,
        dependencies: [fixture.dependency],
        nodeModulesRoot: NodePath.join(fixture.directory, "node_modules"),
        output: NodePath.join(fixture.directory, "dynamic-create-require"),
        transformSource: (source) => rewriteClaudeSdkCreateRequire(source),
      }),
    ).rejects.toThrow("CLAUDE_SDK_CREATE_REQUIRE_DYNAMIC_SPECIFIER");
  });
});
