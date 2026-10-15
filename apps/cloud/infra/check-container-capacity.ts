// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - Standalone CI check, run with plain node.
/**
 * Reports how full production's containers are and writes an alert body when
 * one is at 80% of its cap (`.github/workflows/cloud-container-capacity.yml`
 * opens the issue):
 *
 *   node apps/cloud/infra/check-container-capacity.ts <alert body file>
 *
 * Reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. The body file is
 * written only when something is near its cap.
 */
import * as NodeFS from "node:fs";

import {
  type CapacityRow,
  type ContainerApplication,
  containerCapacity,
  NEAR_CAP_SHARE,
} from "./containerCapacity.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

async function listApplications(): Promise<ReadonlyArray<ContainerApplication>> {
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`,
    { headers: { Authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` } },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Containers API ${response.status}: ${text}`);
  const body = JSON.parse(text) as {
    success: boolean;
    result?: ReadonlyArray<ContainerApplication>;
  };
  if (!body.success || body.result === undefined) throw new Error(`Containers API: ${text}`);
  return body.result;
}

const table = (rows: ReadonlyArray<CapacityRow>) => [
  "| Application | In use | Cap |",
  "| --- | --- | --- |",
  ...rows.map((row) => `| \`${row.name}\` | ${row.inUse} | ${row.max} |`),
];

async function main(argv: ReadonlyArray<string>) {
  const [alertFile] = argv;
  if (alertFile === undefined) {
    throw new Error("Usage: check-container-capacity.ts <alert body file>");
  }
  const rows = containerCapacity(await listApplications());
  const lines = table(rows);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ["### Container capacity", ...lines, ""].join("\n"),
    );
  }
  const near = rows.filter((row) => row.nearCap);
  if (near.length === 0) return;
  const percent = Math.round(NEAR_CAP_SHARE * 100);
  NodeFS.writeFileSync(
    alertFile,
    [
      `Production containers are at ${percent}% or more of their cap: ${near.map((row) => `\`${row.name}\``).join(", ")}.`,
      "",
      ...lines,
      "",
      "At the cap a pool can't start its container and a turn fails with \"No machine came up\". Raise `maxInstances` in `apps/cloud/infra/stage.ts`, or find out what's holding containers.",
      "",
    ].join("\n"),
  );
}

if (import.meta.main) await main(process.argv.slice(2));
