import * as Schema from "effect/Schema";
import { parseDeploy3Name } from "./deadline.ts";
import { deploy3BootstrapIdentity } from "./expiry.ts";
import { isoAt } from "./platform.ts";
import type { Deploy3ControlComment } from "./controlRegistry.ts";

export const BOOTSTRAP_MARKER = "<!-- signalbox-deploy3-bootstrap-v1 -->\n";
const Bootstrap = Schema.Struct({
  runId: Schema.String,
  workerName: Schema.String,
  startedAtUtc: Schema.String,
  operatorTokenId: Schema.String,
  operatorTokenExpiresOn: Schema.String,
  owners: Schema.Array(Schema.Literals(["1070", "1255"])),
});
export type Deploy3Bootstrap = typeof Bootstrap.Type;
const decodeBootstrap = Schema.decodeUnknownSync(Bootstrap);
const decodeBootstrapJson = Schema.decodeSync(Schema.fromJsonString(Bootstrap));

export function decodeDeploy3BootstrapJson(value: string) {
  const row = decodeBootstrapJson(value);
  bootstrapBody(row);
  return row;
}

export function requireDeploy3Bootstrap(
  records: readonly Deploy3Bootstrap[],
  expected: Deploy3Bootstrap,
) {
  const body = bootstrapBody(expected);
  if (!records.some((row) => bootstrapBody(row) === body)) {
    throw new Error("Worker upload requires the durable exact bootstrap credential record");
  }
}

export function bootstrapBody(value: unknown) {
  const row = decodeBootstrap(value);
  const started = Date.parse(row.startedAtUtc);
  const parsed = parseDeploy3Name(row.workerName);
  if (
    !Number.isSafeInteger(started) ||
    isoAt(started) !== row.startedAtUtc ||
    !parsed ||
    parsed.role !== "workload" ||
    parsed.runId !== row.runId ||
    deploy3BootstrapIdentity(row.runId, started).workerName !== row.workerName ||
    deploy3BootstrapIdentity(row.runId, started).operatorTokenExpiresOn !==
      row.operatorTokenExpiresOn ||
    !/^[a-f0-9]{32}$/.test(row.operatorTokenId) ||
    !row.owners.includes("1070") ||
    row.owners.length > 2 ||
    new Set(row.owners).size !== row.owners.length
  ) {
    throw new Error("Invalid deployment bootstrap identity");
  }
  return BOOTSTRAP_MARKER + JSON.stringify(row);
}

export function reconcileDeploy3Bootstraps(
  comments: readonly Deploy3ControlComment[],
  trustedWriters: readonly number[],
) {
  const records: Deploy3Bootstrap[] = [];
  for (const comment of comments) {
    if (!trustedWriters.includes(comment.user.id) || !comment.body.startsWith(BOOTSTRAP_MARKER))
      continue;
    const record = decodeBootstrapJson(comment.body.slice(BOOTSTRAP_MARKER.length));
    if (
      bootstrapBody(record) !== comment.body ||
      records.some((row) => row.runId === record.runId)
    ) {
      throw new Error("Conflicting or noncanonical bootstrap control");
    }
    records.push(record);
  }
  return records;
}
