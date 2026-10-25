import * as NodeFSP from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { parseReleaseCoverageCorpus } from "../../claude-bunfs/release-omission.ts";

it("parses the pinned corpus and retains inputs reached by partial sessions, recovery and broader tool paths", async () => {
  const corpus = parseReleaseCoverageCorpus(
    JSON.parse(
      await NodeFSP.readFile(
        new URL("./claude-code-2.1.303-linux-x64.json", import.meta.url),
        "utf8",
      ),
    ),
  );

  // Fresh-resume module #1070 hit in the omitted release.
  expect(corpus.inputs).toContainEqual({
    inputPath: "bun-graph:/$bunfs/root/chunk-6hh08p3q.js",
    initialized: true,
  });

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
    "bun-graph:/$bunfs/root/chunk-1xn1h09a.js",
    "bun-graph:/$bunfs/root/chunk-1yk0b2ky.js",
    "bun-graph:/$bunfs/root/chunk-e2derxke.js",
    "bun-graph:/$bunfs/root/chunk-epvse6vk.js",
    "bun-graph:/$bunfs/root/chunk-hfrg3wrg.js",
    "bun-graph:/$bunfs/root/chunk-knvpnmph.js",
    "bun-graph:/$bunfs/root/chunk-rea1e3db.js",
    "bun-graph:/$bunfs/root/chunk-s22n3b79.js",
    "bun-graph:/$bunfs/root/chunk-xj41x97a.js",
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
  for (const provenance of [
    {
      name: "v6-unomitted-release.js",
      sha256: "86e0f3676ea87b35e83606776a2bd67a9dd98b74e80d57efcccf8961921bb854",
    },
    {
      name: "v6-capture-resume-r4/resume-checkpoint",
      sha256: "68da316689763e634a99dc8e00c7b637d847b3a3c58fe7a731b1295150105495",
    },
    {
      name: "v6-capture-resume-r4/continue-checkpoint",
      sha256: "89385c1aa8a0743298e863aaadfafd2dad210f2561a84ab1fa11ad4806275e32",
    },
    {
      name: "v6-interrupt-r2/interrupt-resume",
      sha256: "cb83703e636da90016f8cd32334d497fb9a5906a896bd157e96258a4bd0ea85e",
    },
    {
      name: "v6-interrupt-r2/interrupt-continue",
      sha256: "cd6a7467c86d4c80af553e7c2e3600d419e6f835a28fc254cbaa649c7a79f0a5",
    },
  ]) {
    expect(corpus.provenance).toContainEqual(provenance);
  }
  for (const inputPath of [
    "bun-graph:/$bunfs/root/chunk-0d3k7c10.js",
    "bun-graph:/$bunfs/root/chunk-2gfdk5g7.js",
    "bun-graph:/$bunfs/root/chunk-3ra9kcfr.js",
    "bun-graph:/$bunfs/root/chunk-3rd1783e.js",
    "bun-graph:/$bunfs/root/chunk-5befw1yz.js",
    "bun-graph:/$bunfs/root/chunk-7kqyz64t.js",
    "bun-graph:/$bunfs/root/chunk-8crv3dwn.js",
    "bun-graph:/$bunfs/root/chunk-8mp04ez5.js",
    "bun-graph:/$bunfs/root/chunk-9hxmx5h0.js",
    "bun-graph:/$bunfs/root/chunk-bvd74m7c.js",
    "bun-graph:/$bunfs/root/chunk-cc7amj64.js",
    "bun-graph:/$bunfs/root/chunk-cnzzwgfw.js",
    "bun-graph:/$bunfs/root/chunk-d8chec4f.js",
    "bun-graph:/$bunfs/root/chunk-dnv50g9q.js",
    "bun-graph:/$bunfs/root/chunk-gdnd7mmb.js",
    "bun-graph:/$bunfs/root/chunk-h3madgmg.js",
    "bun-graph:/$bunfs/root/chunk-rpgd9nph.js",
    "bun-graph:/$bunfs/root/chunk-vqa3vv4s.js",
  ]) {
    expect(corpus.inputs).toContainEqual({ inputPath, initialized: true });
  }
  for (const provenance of [
    {
      name: "v7-agent-background/r2/coverage",
      sha256: "c9f07ecb2feda7d73556fbb37faa29b7e903ce738a0107de1c22d94a994353f9",
    },
    {
      name: "v7-core/agent-subagent/coverage",
      sha256: "9a7015722f45c430894880d0c0713c3d018b219b2e2ec215ea6b6a2f8c121416",
    },
    {
      name: "v7-core/background-bash-notification/coverage",
      sha256: "ded688e859c61dd7542be63e3771f49094d149e1d980279ce1017841996e17ac",
    },
    {
      name: "v7-core/image-read/coverage",
      sha256: "ba7b7aaa6fc22628e8972b83f9f1508456b00bd8ec3f088a6a402f9a06c4f009",
    },
    {
      name: "v7-core/permission-prompt-denial/coverage",
      sha256: "3651be822224b63a7f087f8a86a42eec9fc47a592ba9846bf94c3aeea765fd4b",
    },
    {
      name: "v7-core/todo-write/coverage",
      sha256: "c5ff2ff534cd54cf1be3a6fa8d2cf50340a4b92aa125649c2a5ad75fc4a4e7d3",
    },
    {
      name: "v7-integrations/scenarios/hooks/coverage",
      sha256: "af3e927573d86b4eb1e961c8b66d2cb533efa8991fc253d67bce951ea52a3242",
    },
    {
      name: "v7-integrations/scenarios/mcp-http/coverage",
      sha256: "bd5a7684da331033169fe6bb9e4eca0bde330b17094fbb7ab6a2f349b46bc43a",
    },
    {
      name: "v7-integrations/scenarios/mcp-stdio/coverage",
      sha256: "baeac8bfde3c4d226850f7b11eb1c1bf28e1fce1f0275815ab0fcc8e58a4ebcb",
    },
    {
      name: "v7-integrations/scenarios/mcp-stdio-first-attempt/coverage",
      sha256: "d12c8e06ea47e884dfe8881389bf11fe92bc9922b30ee0ed6d238cc74d9efa32",
    },
    {
      name: "v7-integrations/scenarios/plugin/coverage",
      sha256: "ee9484b19dd1c0c3ba7547682ec0f9df779fbf5c39f039c38b640f3a8e287b73",
    },
    {
      name: "v7-integrations/scenarios/webfetch/coverage",
      sha256: "1b1d8d1feca0192a59516758251f393a4c21fda43e1efb4f54647abb24c0ed08",
    },
    {
      name: "v7-integrations/scenarios/webfetch-https-retry/coverage",
      sha256: "44556faf047314db3b75c85331d3e0dc68fa2a8b5ba1def7b1393cae2930035e",
    },
    {
      name: "v7-integrations/scenarios/websearch/coverage",
      sha256: "42ab87d02fbba2d972ff3df3f1136ab563292a94629890a8275dda1049b8174f",
    },
    {
      name: "v7-session/r1/auto-compact/coverage",
      sha256: "506067d48fef5124666fe5107a062a7ee149680ede299998ab8f33bb421dfce1",
    },
    {
      name: "v7-session/r1/settings-model-style/coverage",
      sha256: "327cd5dcea9a4e29993bf1084665b403cc179ca1c8c92686dc66476f5220a449",
    },
    {
      name: "v7-session/r1/slash-compact/coverage",
      sha256: "4ad08618f8f48d975dc4ac6de3033d4797d1c49e4b57070bde44e191b61d0287",
    },
    {
      name: "v7-session/r1/slash-context/coverage",
      sha256: "8c949acd68d8102e8597cafb263f37f08d3d0d07082e1696de0c7c54af927407",
    },
    {
      name: "v7-session/r2/custom-style/coverage",
      sha256: "443d5d04679216c573f27f579f78185d4226ea5f0aad2454229c7586abbaa0cb",
    },
    {
      name: "v7-workers/attempt-2/coverage",
      sha256: "33688011596e5cf8c444acbf6e259f0b35856bf18e0cd547931f8a55f2b35f0a",
    },
    {
      name: "v7-workers/coverage",
      sha256: "c559fa47341ffb93d6eef6f015a3a72fff8bd67e15b0e94ba500892ea54068f8",
    },
  ]) {
    expect(corpus.provenance).toContainEqual(provenance);
  }
  expect(corpus.pending).toEqual([
    "session-C-from-1244",
    "session-A-from-1244",
    "session-B-from-1244",
    "WebSearch-completion",
    "TodoWrite-unavailable-in-2.1.303-headless-toolset",
    "output-style-prompt-application",
    "plugin-function-hooks-worker: Worker is not defined (recapture after #1396)",
  ]);
});
