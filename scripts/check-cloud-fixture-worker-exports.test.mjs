import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";

const checker = new URL("./check-cloud-fixture-worker-exports.mjs", import.meta.url);

async function fixtureRoot(mainSource, options = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cloud-fixture-exports-"));
  const sourceDir = NodePath.join(root, "apps/cloud/src");
  const prepareDir = NodePath.join(root, "apps/cloud/infra/isolateProbe");
  const outputDir = NodePath.join(root, "generated-output");
  await NodeFSP.mkdir(sourceDir, { recursive: true });
  await NodeFSP.mkdir(prepareDir, { recursive: true });
  await NodeFSP.mkdir(outputDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(sourceDir, "FixtureWorkerExports.ts"),
    'export * from "./worker.ts";\n',
  );
  await NodeFSP.writeFile(NodePath.join(sourceDir, "worker.ts"), "export class Fixture {}\n");
  await NodeFSP.writeFile(
    NodePath.join(prepareDir, "prepare.ts"),
    'export const source = "../../src/FixtureWorkerExports.ts";\nexport const output = "FixtureWorkerExports.js";\n',
  );
  if (options.unrelatedTarget !== undefined)
    await NodeFSP.writeFile(NodePath.join(outputDir, "unrelated.ts"), options.unrelatedTarget);
  if (options.unusedExport === true)
    await NodeFSP.writeFile(
      NodePath.join(sourceDir, "unrelatedGeneratedExport.ts"),
      'export const unrelatedGeneratedSource = `export * from "./unrelated.ts";`;\nexport const sharedMention = "FixtureWorkerExports";\n',
    );
  const unusedImport =
    options.unusedExport === undefined ? "" : 'import "./unrelatedGeneratedExport.ts";\n';
  const generatedMain =
    typeof mainSource === "function"
      ? mainSource({
          root,
          sourceDir,
          outputDir,
          sharedExports: NodePath.join(sourceDir, "FixtureWorkerExports.ts"),
        })
      : mainSource;
  await NodeFSP.writeFile(
    NodePath.join(sourceDir, "generatedWorker.test.ts"),
    `import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createTestHarness } from "wrangler";
${unusedImport}const mainSource = ${JSON.stringify(generatedMain)};
const output = ${JSON.stringify(outputDir)};
await NodeFSP.writeFile(NodePath.join(output, "generated.js"), mainSource);
createTestHarness({ workers: [{ config: {
  main: "generated.js",
  compatibility_date: "2026-10-19",
}}] });
`,
  );
  return root;
}

function check(root) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    [NodeURL.fileURLToPath(checker), "--root", root],
    { encoding: "utf8" },
  );
}

async function withFixture(mainSource, options, run) {
  const root = await fixtureRoot(mainSource, options);
  try {
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

NodeTest.test("checks the export in the generated main source", async () => {
  await withFixture(
    ({ sharedExports }) => `export * from ${JSON.stringify(sharedExports)};\nexport default {};\n`,
    {},
    (root) => {
      const result = check(root);
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.match(result.stdout, /1 generated roots/);
    },
  );
});

NodeTest.test("does not borrow an export template from an unrelated imported module", async () => {
  await withFixture(
    ({ outputDir }) =>
      `export * from ${JSON.stringify(NodePath.join(outputDir, "unrelated.ts"))};\nexport default {};\n`,
    { unrelatedTarget: "export const marker = true;\n", unusedExport: true },
    (root) => {
      const result = check(root);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /has no production export in its generated Worker source/);
    },
  );
});

NodeTest.test("rejects a generated main whose actual export target is unrelated", async () => {
  await withFixture(
    ({ outputDir }) =>
      `export * from ${JSON.stringify(NodePath.join(outputDir, "unrelated.ts"))};\nexport default {};\n`,
    { unrelatedTarget: "export const marker = true;\n" },
    (root) => {
      const result = check(root);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /has no production export in its generated Worker source/);
    },
  );
});

NodeTest.test("rejects an unresolved export target", async () => {
  await withFixture(
    ({ outputDir }) =>
      `export * from ${JSON.stringify(NodePath.join(outputDir, "missing.ts"))};\nexport default {};\n`,
    {},
    (root) => {
      const result = check(root);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /has no production export in its generated Worker source/);
    },
  );
});

NodeTest.test(
  "rejects a transformed generated main instead of checking its original template",
  async () => {
    await withFixture(
      ({ sharedExports }) =>
        `export * from ${JSON.stringify(sharedExports)};\nexport default {};\n`,
      { unrelatedTarget: "export const marker = true;\n" },
      async (root) => {
        const sourcePath = NodePath.join(root, "apps/cloud/src/generatedWorker.test.ts");
        const source = await NodeFSP.readFile(sourcePath, "utf8");
        const original = NodePath.join(root, "apps/cloud/src/FixtureWorkerExports.ts");
        const replacement = NodePath.join(root, "generated-output/unrelated.ts");
        await NodeFSP.writeFile(
          sourcePath,
          source.replace(
            ", mainSource);",
            `, mainSource.replace(${JSON.stringify(original)}, ${JSON.stringify(replacement)}));`,
          ),
        );
        const result = check(root);
        NodeAssert.notEqual(result.status, 0);
        NodeAssert.match(result.stderr, /has no production export in its generated Worker source/);
      },
    );
  },
);

NodeTest.test("rejects an unresolved explicit harness main override", async () => {
  await withFixture(
    ({ sharedExports }) => `export * from ${JSON.stringify(sharedExports)};\nexport default {};\n`,
    {},
    async (root) => {
      const sourcePath = NodePath.join(root, "apps/cloud/src/generatedWorker.test.ts");
      await NodeFSP.appendFile(
        sourcePath,
        "\ncreatePublicResumeHarness({ main: chooseWorkerMain() });\n",
      );
      const result = check(root);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /cannot resolve fixture Worker main override/);
    },
  );
});
