import * as NodeFSP from "node:fs/promises";
import { buildCombinedFixture } from "./buildFixture.ts";
import { decodeCombinedFixtureInput } from "./bundleInput.ts";

const [inputPath, ...extra] = process.argv.slice(2);
if (!inputPath || extra.length)
  throw new Error("Usage: node build.ts <combined-fixture-input.json>");
const input = decodeCombinedFixtureInput(JSON.parse(await NodeFSP.readFile(inputPath, "utf8")));
const result = await buildCombinedFixture(input);
process.stdout.write(
  `${JSON.stringify({
    classification: result.classification,
    outputDirectory: input.outputDirectory,
    configSha256: result.configSha256,
    qualification: result.qualification,
    deploymentReady: result.deploymentReady,
  })}\n`,
);
