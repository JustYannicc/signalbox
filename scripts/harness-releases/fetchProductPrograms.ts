import * as NodeUtil from "node:util";
import { fetchProductProgramInputs } from "./productProgramInputs.ts";

const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, token: { type: "string" }, help: { type: "boolean" } },
});

if (values.help) {
  process.stdout.write(
    "Usage: node scripts/harness-releases/fetchProductPrograms.ts --output NEW_DIRECTORY [--token TOKEN]\n",
  );
} else {
  if (!values.output) throw new Error("Usage: fetchProductPrograms.ts --output NEW_DIRECTORY");
  const result = await fetchProductProgramInputs(values.output, { token: values.token });
  process.stdout.write(
    `${JSON.stringify({ status: result.receipt.status, directory: result.directory })}\n`,
  );
}
