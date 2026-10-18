import { describe, expect, it } from "vitest";
import * as Esbuild from "esbuild";
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
});
