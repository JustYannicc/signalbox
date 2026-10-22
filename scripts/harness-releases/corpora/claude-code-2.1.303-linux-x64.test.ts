import * as NodeFSP from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { parseReleaseCoverageCorpus } from "../../claude-bunfs/release-omission.ts";

it("parses the pinned corpus and retains inputs reached by partial sessions", async () => {
  const corpus = parseReleaseCoverageCorpus(
    JSON.parse(
      await NodeFSP.readFile(
        new URL("./claude-code-2.1.303-linux-x64.json", import.meta.url),
        "utf8",
      ),
    ),
  );

  expect(corpus.binarySha256).toBe(
    "375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450",
  );
  expect(corpus.inputs).toContainEqual({
    inputPath: "bun-graph:/$bunfs/root/chunk-rmj72q0z.js",
    initialized: true,
  });
  expect(corpus.provenance).toContainEqual({
    name: expect.stringContaining("partial session C"),
    sha256: "eb5130dc3e798df0836745ed5839c761e440d807e75573939a360ff519f385cc",
  });
  expect(corpus.provenance).toContainEqual({
    name: "session-C-r109-partial",
    sha256: "fbd02ad2991c25657fcbbeb43890a669fd584a54115a81e4c24f1c9ec1095d89",
  });
  expect(corpus.provenance).toContainEqual({
    name: "session-A-r109-partial",
    sha256: "2408124c2cb08e4e8e7fe3a946fe956c8c4f8115b76bec5d7ccc2a459988e318",
  });
  for (const inputPath of [
    "bun-graph:/$bunfs/root/chunk-cc837y02.js",
    "bun-graph:/$bunfs/root/chunk-y4vjzwc0.js",
  ]) {
    expect(corpus.inputs).toContainEqual({ inputPath, initialized: true });
  }
  for (const provenance of [
    {
      name: "session-C-r110-partial",
      sha256: "2e03b762e8338f45e790d233ade0deb360dda2651f5e12358240bdcfdb5e7740",
    },
    {
      name: "session-A-r110-partial",
      sha256: "94b8958b074f76ffdc2981d9acf869182c62622109fff06ac50566c2a867f33e",
    },
    {
      name: "session-B-r110-partial",
      sha256: "53b2f07a77b36982f7225e92af935372c4bcb88e1d95cf41e225f0f8b3b70c57",
    },
    {
      name: "session-C-r113-partial",
      sha256: "53b15d0edf975f3c4ccda2b624471f33d485a5f0598915e5be46a04ab0722503",
    },
    {
      name: "session-A-r113-partial",
      sha256: "f60c9f8546ad1e4fac1815c4aec78946d8db9d381bab523db801c720a6de0798",
    },
  ]) {
    expect(corpus.provenance).toContainEqual(provenance);
  }
  expect(corpus.pending).toEqual([
    "session-C-from-1244",
    "session-A-from-1244",
    "session-B-from-1244",
    "WebSearch-completion",
  ]);
});
