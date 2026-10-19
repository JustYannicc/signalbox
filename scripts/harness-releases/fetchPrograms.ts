import * as NodeUtil from "node:util";
import { fetchProgramInputs } from "./programInputs.ts";

const { values } = NodeUtil.parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Usage: fetchPrograms.ts --output NEW_DIRECTORY");
await fetchProgramInputs(values.output);
