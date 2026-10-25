// @effect-diagnostics nodeBuiltinImport:off - inspect source URLs in build-time normalization tests.
import { describe, expect, it } from "@effect/vitest";
import * as Esbuild from "esbuild";
import * as NodeURL from "node:url";
import { normalizeModule } from "./normalize.ts";

describe("Bun module normalization", () => {
  it("executes legacy bare CommonJS wrappers with their original filename", async () => {
    const normalized = normalizeModule({
      name: "/$bunfs/root/src/cli.js",
      key: "$bunfs/root/src/cli.js",
      format: 2,
      source:
        "// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {module.exports={value:42,file:__filename,dir:__dirname};})",
    });
    const result = await Esbuild.transform(normalized.source, { loader: "js", format: "esm" });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
    );
    expect(module.default).toEqual({
      value: 42,
      file: "/$bunfs/root/src/cli.js",
      dir: "/$bunfs/root/src",
    });
  });

  it("adapts Bun meta properties without rewriting strings or comments", () => {
    const normalized = normalizeModule({
      name: "/$bunfs/root/cli",
      key: "$bunfs/root/cli",
      format: 1,
      source:
        'const literal="import.meta.require"; /* import.meta.dir */ const d=import.meta.dir; const f=import.meta.path; export const value=import.meta.require("node:path");',
    });
    expect(normalized.source).toContain(
      'const literal="import.meta.require"; /* import.meta.dir */',
    );
    expect(normalized.source).toContain('const d="/$bunfs/root"');
    expect(normalized.source).toContain('const f="/$bunfs/root/cli"');
    expect(normalized.source).toContain('export const value=require("node:path")');
  });

  it("keeps source file URLs through bundling instead of the output module URL", async () => {
    const name = "/$bunfs/root/nested #/%25/ä source.js";
    const normalized = normalizeModule({
      name,
      key: name.slice(1),
      format: 1,
      source: `export const url=import.meta.url;
        export const bracketUrl=import.meta["url"];
        export const filename=import.meta.filename;
        export const dirname=import.meta.dirname;`,
    });
    const result = await Esbuild.transform(normalized.source, { loader: "js", format: "esm" });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
    );
    expect(module.url).toBe("file:///$bunfs/root/nested%20%23/%2525/%C3%A4%20source.js");
    expect(module.bracketUrl).toBe(module.url);
    expect(NodeURL.fileURLToPath(module.url, { windows: false })).toBe(name);
    expect(module.filename).toBe(name);
    expect(module.dirname).toBe("/$bunfs/root/nested #/%25");
  });

  it("preserves Windows guest metadata independently of the build host", async () => {
    const name = "B:\\~BUN\\root\\nested #\\cli.js";
    const normalized = normalizeModule({
      name,
      key: "~BUN/root/nested #/cli.js",
      format: 1,
      source: "export const value=[import.meta.url,import.meta.filename,import.meta.dirname]",
    });
    const result = await Esbuild.transform(normalized.source, { loader: "js", format: "esm" });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
    );
    expect(module.value).toEqual([
      "file:///B:/%7EBUN/root/nested%20%23/cli.js",
      name,
      "B:\\~BUN\\root\\nested #",
    ]);
    expect(NodeURL.fileURLToPath(module.value[0], { windows: true })).toBe(name);
    expect(() =>
      normalizeModule({
        name: "relative.js",
        key: "relative.js",
        format: 1,
        source: "import.meta.url",
      }),
    ).toThrow("BUN_MODULE_URL_PATH_INVALID");
  });

  it("rejects unfamiliar CommonJS shapes before emitting a misleading artifact", () => {
    expect(() =>
      normalizeModule({ name: "cli", key: "cli", format: 2, source: "(() => 42)" }),
    ).toThrow("BUN_CJS_SHAPE_CHANGED");
  });

  it("preserves strict directives and entry-module identity", async () => {
    const legacy = normalizeModule({
      name: "/$bunfs/root/cli",
      key: "$bunfs/root/cli",
      format: 2,
      source:
        '(function(exports,require,module,__filename,__dirname){"use strict";module.exports=(function(){return this})()===undefined;})',
    });
    const result = await Esbuild.transform(legacy.source, { loader: "js", format: "esm" });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
    );
    expect(module.default).toBe(true);
    expect(
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 1,
        isEntry: true,
        source: "export const main=import.meta.main",
      }).source,
    ).toBe("export const main=true");
    expect(
      normalizeModule({
        name: "dep",
        key: "dep",
        format: 1,
        source: "export const main=import.meta.main",
      }).source,
    ).toBe("export const main=false");
  });

  it("rejects wrapper signatures whose bindings would change when flattened", () => {
    expect(() =>
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 2,
        source:
          "(function self(exports,require,module,__filename,__dirname){module.exports=typeof self;})",
      }),
    ).toThrow("BUN_CJS_SHAPE_CHANGED");
    expect(() =>
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 2,
        source:
          "(function(exports,require,module,__filename,...__dirname){module.exports=__dirname;})",
      }),
    ).toThrow("BUN_CJS_SHAPE_CHANGED");
    expect(() =>
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 2,
        source:
          '(function(exports,require,module,__filename,__dirname="default"){module.exports=__dirname;})',
      }),
    ).toThrow("BUN_CJS_SHAPE_CHANGED");
  });

  it("rejects requires captured by parameters, destructuring, or hoisted variables", () => {
    const normalize = (source: string) =>
      normalizeModule({ name: "cli", key: "cli", format: 1, source });
    expect(() => normalize('export const load=require=>import.meta.require("node:path")')).toThrow(
      "BUN_REQUIRE_SHADOWED",
    );
    expect(() =>
      normalize('function load({require}){return import.meta.require("node:path")}'),
    ).toThrow("BUN_REQUIRE_SHADOWED");
    expect(() =>
      normalize(
        'function load(){const result=import.meta.require("node:path");if(false){var require;}return result}',
      ),
    ).toThrow("BUN_REQUIRE_SHADOWED");
    expect(() => normalize('try{}catch(require){import.meta.require("node:path")}')).toThrow(
      "BUN_REQUIRE_SHADOWED",
    );
    expect(
      normalize(
        'function unrelated(require){} export const result=import.meta.require("node:path")',
      ).source,
    ).toContain('export const result=require("node:path")');
  });

  it("handles sloppy block functions and isolates switch and static-block bindings", () => {
    const body =
      'function load(){if(true){function require(){return "captured"}}return import.meta.require("node:path")}';
    expect(() =>
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 2,
        source: `(function(exports,require,module,__filename,__dirname){${body}})`,
      }),
    ).toThrow("BUN_REQUIRE_SHADOWED");
    expect(() =>
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 2,
        source: `(function(exports,require,module,__filename,__dirname){"use\\x20strict";${body}})`,
      }),
    ).toThrow("BUN_REQUIRE_SHADOWED");
    for (const source of [
      `"use strict";${body}`,
      'switch(0){case 0: let require;} export const result=import.meta.require("node:path");',
      'class Example { static { var require; } } export const result=import.meta.require("node:path");',
    ])
      expect(normalizeModule({ name: "cli", key: "cli", format: 1, source }).source).toContain(
        'require("node:path")',
      );
    expect(() =>
      normalizeModule({
        name: "cli",
        key: "cli",
        format: 1,
        source: 'switch(0){case 0:let require;import.meta.require("node:path");}',
      }),
    ).toThrow("BUN_REQUIRE_SHADOWED");
  });
});
