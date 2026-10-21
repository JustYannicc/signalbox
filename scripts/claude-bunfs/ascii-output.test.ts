import * as Esbuild from "esbuild";
import { describe, expect, it } from "@effect/vitest";
import { oneByteReleaseModules } from "./ascii-output.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function build(source: string) {
  const result = await Esbuild.build({
    stdin: { contents: source, loader: "js", sourcefile: "entry.js" },
    outfile: "/out/release.js",
    bundle: true,
    write: false,
    format: "esm",
    minifyWhitespace: true,
    legalComments: "external",
    target: "es2022",
  });
  return result.outputFiles.map((file) => ({
    path: file.path.slice("/out/".length),
    contents: file.contents,
  }));
}

describe("ASCII release output", () => {
  it("keeps a wide legal notice in the module as ASCII so the source stays one byte per character", async () => {
    const files = oneByteReleaseModules(
      await build('/*! (c) 2015–2016 whatwg \u{1F600} */\nexport const s = "–é";'),
    );
    expect(files.map((file) => file.path)).toEqual(["release.js"]);
    const [release] = files;
    expect(release!.contents.every((byte) => byte < 0x80)).toBe(true);
    const text = decode(release!.contents);
    expect(text).toContain("// /*! (c) 2015\\u{2013}2016 whatwg \\u{1f600} */");
    const module = await import(`data:text/javascript,${encodeURIComponent(text)}`);
    expect(module.s).toBe("–é");
  });

  it("rejects a wide character esbuild leaves in code", async () => {
    const files = await build("export const raw = String.raw`–`;");
    expect(() => oneByteReleaseModules(files)).toThrow("BUNDLE_WIDE_SOURCE: release.js");
  });

  it("accepts Latin-1 that esbuild leaves in code, since it still fits one byte per character", async () => {
    const [release] = oneByteReleaseModules(await build("export const raw = String.raw`\u00e9`;"));
    const module = await import(
      `data:text/javascript,${encodeURIComponent(decode(release!.contents))}`
    );
    expect(module.raw).toBe("\u00e9");
  });
});
