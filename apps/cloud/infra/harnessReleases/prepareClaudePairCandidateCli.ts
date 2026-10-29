import { DateTime, Effect } from "effect";
import * as NodeUtil from "node:util";
import { prepareClaudePairCandidate } from "./prepareClaudePairCandidate.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "baseline-cli": { type: "string" },
    "hooks-cli": { type: "string" },
    sdk: { type: "string" },
    programs: { type: "string" },
    "machine-inventory": { type: "string" },
    "max-prepared-module-bytes": { type: "string" },
    "project-id": { type: "string" },
    output: { type: "string" },
  },
});
const required = (name: keyof typeof values) => {
  const value = values[name];
  if (!value) throw new Error(`Pass --${name}.`);
  return value;
};
const createdAt = DateTime.formatIso(await Effect.runPromise(DateTime.now));
const result = await prepareClaudePairCandidate({
  createdAt,
  baselineCli: required("baseline-cli"),
  hooksCli: required("hooks-cli"),
  sdk: required("sdk"),
  programs: required("programs"),
  machineInventory: required("machine-inventory"),
  maxPreparedModuleBytes: Number(required("max-prepared-module-bytes")),
  output: required("output"),
  ...(values["project-id"] === undefined ? {} : { projectId: values["project-id"] }),
});
process.stdout.write(
  `${JSON.stringify({ status: result.status, qualification: result.qualification })}\n`,
);
