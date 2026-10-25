// @effect-diagnostics nodeBuiltinImport:off - build and execute a split module graph from a temporary fixture.
import { describe, expect, it } from "@effect/vitest";
import * as Esbuild from "esbuild";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createDeferredInitialization } from "./deferred-initialization.ts";

describe("deferred release initialization", () => {
  it("defers split static and dynamic graphs while preserving module semantics", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deferred-claude-"));
    try {
      const output = NodePath.join(root, "output");
      const deferred = createDeferredInitialization();
      const modules: Readonly<Record<string, string>> = {
        "entry.js": `
          import {identity, count, increment} from './shared.js';
          import {fromA} from './cycle-a.js';
          if (globalThis.__deferredImportPhase) throw new Error('entry initialized during import');
          globalThis.deferredEvents.push('entry');
          export async function run() {
            increment();
            const later = await import('./later.js');
            const nested = await later.loadNested();
            later.increment();
            const laterAgain = await import('./later.js');
            const common = await import('./common.cjs');
            const commonAgain = await import('./common.cjs');
            const failures = [];
            for (let attempt = 0; attempt < 2; attempt++) {
              try { await import('./failure.js'); } catch (error) { failures.push(error); }
            }
            return {
              cycle: fromA(),
              sharedIdentity: later.identity === identity && nested.identity === identity,
              liveValues: [count, later.count, nested.count, later.readCount()],
              laterNamespaceStable: later === laterAgain,
              commonNamespaceStable: common === commonAgain,
              commonDefault: common.default,
              commonNamed: common.named,
              failureCount: globalThis.deferredFailureCount,
              sameFailure: failures[0] === failures[1],
              failureMessages: failures.map((failure) => failure.message),
            };
          }
        `,
        "shared.js": `
          if (globalThis.__deferredImportPhase) throw new Error('shared initialized during import');
          globalThis.deferredEvents.push('shared');
          export const identity = {};
          export let count = 0;
          export function increment() { count++; }
        `,
        "cycle-a.js": `
          import {fromB} from './cycle-b.js';
          if (globalThis.__deferredImportPhase) throw new Error('cycle-a initialized during import');
          globalThis.deferredEvents.push('cycle-a');
          export const fromA = () => 'a' + fromB();
        `,
        "cycle-b.js": `
          import {fromA} from './cycle-a.js';
          if (globalThis.__deferredImportPhase) throw new Error('cycle-b initialized during import');
          globalThis.deferredEvents.push('cycle-b');
          export const fromB = () => 'b' + typeof fromA;
        `,
        "later.js": `
          import {identity, count, increment} from './shared.js';
          if (globalThis.__deferredImportPhase) throw new Error('later initialized during import');
          globalThis.deferredEvents.push('later');
          export {identity, count, increment};
          export const readCount = () => count;
          export const loadNested = () => import('./nested.js');
        `,
        "nested.js": `
          import {identity, count} from './shared.js';
          if (globalThis.__deferredImportPhase) throw new Error('nested initialized during import');
          globalThis.deferredEvents.push('nested');
          export {identity, count};
        `,
        "common.cjs": `
          if (globalThis.__deferredImportPhase) throw new Error('common initialized during import');
          globalThis.deferredEvents.push('common');
          module.exports = {default: 'inside', named: 'commonjs'};
        `,
        "failure.js": `
          if (globalThis.__deferredImportPhase) throw new Error('failure initialized during import');
          globalThis.deferredFailureCount = (globalThis.deferredFailureCount ?? 0) + 1;
          throw new Error('deferred failure');
        `,
      };
      const resolveFixture = (specifier: string, importer: string): string | undefined => {
        if (!specifier.startsWith(".")) return undefined;
        const target = NodePath.posix.normalize(
          NodePath.posix.join(NodePath.posix.dirname(importer), specifier),
        );
        const candidates = [target, `${target}.js`, `${target}.cjs`];
        const found = candidates.find((candidate) => Object.hasOwn(modules, candidate));
        return found ? `fixture:${found}` : undefined;
      };
      const built = await Esbuild.build({
        entryPoints: { claude: deferred.entry("fixture:entry.js") },
        outdir: output,
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        metafile: true,
        write: true,
        logLevel: "silent",
        plugins: [
          deferred.plugin,
          {
            name: "deferred-fixture-graph",
            setup(build) {
              build.onResolve({ filter: /^fixture:/ }, (args) => ({
                path: args.path.slice("fixture:".length),
                namespace: "fixture",
              }));
              build.onResolve({ filter: /^\./ }, (args) => {
                if (args.namespace !== "fixture") return;
                const target = resolveFixture(args.path, args.importer);
                if (!target)
                  throw new Error(`FIXTURE_IMPORT_UNRESOLVED: ${args.importer}: ${args.path}`);
                return {
                  path: target.slice("fixture:".length),
                  namespace: "fixture",
                };
              });
              build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
                const source = modules[args.path];
                if (source === undefined) throw new Error(`FIXTURE_MODULE_MISSING: ${args.path}`);
                return {
                  contents: deferred.transform(source, args.path, resolveFixture),
                  loader: "js",
                };
              });
            },
          },
        ],
      });
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      const jsOutputs = Object.keys(built.metafile.outputs).filter((path) => path.endsWith(".js"));
      expect(jsOutputs.length).toBeGreaterThan(1);
      expect(
        Object.values(built.metafile.outputs).some((file) =>
          file.imports.some((dependency) => dependency.kind === "dynamic-import"),
        ),
      ).toBe(true);

      Reflect.set(globalThis, "__deferredImportPhase", true);
      Reflect.set(globalThis, "deferredEvents", []);
      Reflect.set(globalThis, "deferredFailureCount", 0);
      const generated = await import(
        NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href
      );
      expect(Reflect.get(globalThis, "deferredEvents")).toEqual([]);

      Reflect.set(globalThis, "__deferredImportPhase", false);
      const entry = generated.launch();
      expect(generated.launch()).toBe(entry);
      expect(Reflect.get(globalThis, "deferredEvents")).toContain("entry");
      expect(Reflect.get(globalThis, "deferredEvents")).not.toContain("later");
      expect(Reflect.get(globalThis, "deferredEvents")).not.toContain("nested");
      expect(Reflect.get(globalThis, "deferredEvents")).not.toContain("common");

      const result = await entry.run();
      expect(result).toEqual({
        cycle: "abfunction",
        sharedIdentity: true,
        liveValues: [2, 2, 2, 2],
        laterNamespaceStable: true,
        commonNamespaceStable: true,
        commonDefault: { default: "inside", named: "commonjs" },
        commonNamed: "commonjs",
        failureCount: 1,
        sameFailure: true,
        failureMessages: ["deferred failure", "deferred failure"],
      });
      expect(Reflect.get(globalThis, "deferredEvents")).toContain("nested");
      expect(Reflect.get(globalThis, "deferredEvents")).toContain("common");
    } finally {
      Reflect.deleteProperty(globalThis, "__deferredImportPhase");
      Reflect.deleteProperty(globalThis, "deferredEvents");
      Reflect.deleteProperty(globalThis, "deferredFailureCount");
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves unknown dynamic imports and rejects unsupported internal attributes", () => {
    const deferred = createDeferredInitialization();
    const unknown = `export const load = (specifier) => import(specifier); export const external = () => import('external');`;
    expect(deferred.transform(unknown, "fixture.js", () => undefined)).toBe(unknown);

    expect(() =>
      deferred.transform(
        `export const load = () => import('./data.json', {with: {type: 'json'}});`,
        "fixture.js",
        () => "fixture:data.json",
      ),
    ).toThrow("BUNDLE_DEFERRED_IMPORT_ATTRIBUTES_UNSUPPORTED");
  });
});
