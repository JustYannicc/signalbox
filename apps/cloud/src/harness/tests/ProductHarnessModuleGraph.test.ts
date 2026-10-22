// @effect-diagnostics nodeBuiltinImport:off - Approximate a facet loader's module map from emitted sources.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { expect, it } from "vite-plus/test";
import {
  encodeModuleTransport,
  decodeModuleTransport,
} from "../../../infra/isolateProbe/moduleTransport.ts";

const root = NodeURL.fileURLToPath(new URL("../../../../../", import.meta.url));
const harnessRoot = "apps/cloud/src/harness/";
const harnesses = [
  {
    harness: "Claude",
    entry: "ProductClaudeHarnessSessionHost.ts",
    composition: "tests/productHost/scenario.ts",
    binding: "ClaudeNativeHostBinding.ts",
    excluded:
      /(?:^|\/)packages\/provider-codex\/|(?:^|\/)packages\/effect-codex-app-server\/|\/harness\/(?:Codex[^/]*\.ts|codex\/)/,
  },
  {
    harness: "Codex",
    entry: "ProductCodexHarnessSessionHost.ts",
    composition: "tests/productHost/codex.ts",
    binding: "CodexNativeHostBinding.ts",
    excluded: /(?:^|\/)packages\/provider-claude\/|\/harness\/(?:Claude[^/]*\.ts|claude\/)/,
  },
];

it.each(
  harnesses.flatMap(({ entry, composition, ...harness }) => [
    { ...harness, kind: "entry", source: entry },
    { ...harness, kind: "product composition", source: composition },
  ]),
)(
  "$harness registers only its own host graph through $kind",
  async ({ harness, source, binding, excluded }) => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [harnessRoot + source],
      outdir: "facet",
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "node",
      external: ["cloudflare:workers"],
      metafile: true,
      write: false,
    });
    // Include every emitted chunk, even one reachable only through import(). workerd retains
    // each source registered in the loader's module map before any imports run.
    const registered = Object.entries(result.metafile.outputs).filter(([path]) =>
      path.endsWith(".js"),
    );
    const modules = new Map(
      result.outputFiles.map((file) => [NodePath.relative(root, file.path), file.text]),
    );
    expect(registered.length).toBeGreaterThan(0);
    const inputs = [...new Set(registered.flatMap(([, output]) => Object.keys(output.inputs)))];
    expect(inputs).toContain(harnessRoot + binding);
    expect(inputs).toContain(harnessRoot + "host/lifecycle.ts");
    expect(inputs).toContain("apps/cloud/src/kernel/KernelFileSystem.ts");
    expect(inputs.filter((path) => excluded.test(path))).toEqual([]);
    const descriptors = result.outputFiles
      .filter((file) => file.path.endsWith(".js"))
      .map((file) => ({
        name: NodePath.relative(NodePath.join(root, "facet"), file.path),
        type: "js" as const,
        bytes: file.contents,
      }));
    const transport = await decodeModuleTransport(encodeModuleTransport({ harness }, descriptors));
    expect(transport.input).toEqual({ harness });
    expect(Object.keys(transport.modules).sort()).toEqual(
      descriptors.map((module) => module.name).sort(),
    );
    for (const module of descriptors) {
      expect(transport.modules[module.name]).toEqual({
        js: new TextDecoder().decode(module.bytes),
      });
    }
    for (const [path] of registered) {
      const source = modules.get(path);
      expect(source).toBeDefined();
      expect(source).not.toMatch(
        harness === "Claude" ? /makeCodexNativeHostBinding/ : /makeClaudeNativeHostBinding/,
      );
    }
  },
);
