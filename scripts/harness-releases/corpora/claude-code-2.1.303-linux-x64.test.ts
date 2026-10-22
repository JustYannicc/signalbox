import * as NodeFSP from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { parseReleaseCoverageCorpus } from "../../claude-bunfs/release-omission.ts";

it("parses the pinned corpus and retains the input reached by partial session C", async () => {
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
  expect(corpus.pending).toEqual([
    "session-C-from-1244",
    "session-A-from-1244",
    "session-B-from-1244",
    "WebSearch-completion",
  ]);
});
