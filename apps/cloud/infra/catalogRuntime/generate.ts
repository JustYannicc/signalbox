// @effect-diagnostics nodeBuiltinImport:off -- One-shot generation writes the Catalog's native Lunora modules.
import * as NodeFSP from "node:fs/promises";

import { emitLunoraFunctions } from "@signalbox/sync/adapters/lunoraFunctions";
import { lunoraReceiptTables } from "@signalbox/sync/adapters/lunoraReceipts";
import { emitLunoraRecovery } from "@signalbox/sync/adapters/lunoraRecovery";
import { emitLunoraSchema } from "@signalbox/sync/adapters/lunoraSchema";

import {
  catalogOrganizationRuntime,
  catalogPersonalRuntime,
} from "../../src/catalog/catalogRuntimeDefinition.ts";

const sourceDirectory = new URL("../../src/catalog/lunora/", import.meta.url);
const write = (name: string, source: string) =>
  NodeFSP.writeFile(new URL(name, sourceDirectory), source);

await write(
  "schema.ts",
  emitLunoraSchema({
    ...catalogPersonalRuntime.tables,
    ...catalogOrganizationRuntime.tables,
    ...lunoraReceiptTables,
  }).source,
);
await write(
  "personal.ts",
  emitLunoraFunctions(catalogPersonalRuntime, {
    definitionImport: "../catalogRuntimeDefinition.ts",
    definitionExport: "catalogPersonalRuntime",
    bindingImport: "./binding.ts",
  }).source,
);
await write(
  "personalRecovery.ts",
  emitLunoraRecovery(catalogPersonalRuntime.home, {
    bindingImport: "./binding.ts",
    moduleName: "personalRecovery",
  }).source,
);
await write(
  "organization.ts",
  emitLunoraFunctions(catalogOrganizationRuntime, {
    definitionImport: "../catalogRuntimeDefinition.ts",
    definitionExport: "catalogOrganizationRuntime",
    bindingImport: "./organizationBinding.ts",
  }).source,
);
await write(
  "organizationRecovery.ts",
  emitLunoraRecovery(catalogOrganizationRuntime.home, {
    bindingImport: "./organizationBinding.ts",
    moduleName: "organizationRecovery",
  }).source,
);
