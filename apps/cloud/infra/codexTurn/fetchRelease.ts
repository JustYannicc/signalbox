// @effect-diagnostics nodeBuiltinImport:off - local artifact download command.
import * as NodeUtil from "node:util";
import { fetchCodexRelease } from "./release.ts";

const { values } = NodeUtil.parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Usage: fetchRelease.ts --output NEW_DIRECTORY");
const directory = await fetchCodexRelease(values.output);
process.stdout.write(`${JSON.stringify({ directory })}\n`);
