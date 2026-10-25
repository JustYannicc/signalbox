// @effect-diagnostics nodeBuiltinImport:off -- One-shot codegen reads and writes fixture files under plain Node.
import * as NodeFSP from "node:fs/promises";

import { emitLunoraFunctions } from "@signalbox/sync/adapters/lunoraFunctions";
import { lunoraReceiptTables } from "@signalbox/sync/adapters/lunoraReceipts";
import { emitLunoraSchema } from "@signalbox/sync/adapters/lunoraSchema";

import { counterDefinition } from "./home.ts";

const { source } = emitLunoraSchema({ ...counterDefinition.tables, ...lunoraReceiptTables });
await NodeFSP.writeFile(new URL("./lunora/schema.ts", import.meta.url), source);

const functions = emitLunoraFunctions(counterDefinition, {
  definitionImport: "../home.js",
  definitionExport: "counterDefinition",
  bindingImport: "./binding.js",
  serverImport: "./_generated/server.js",
});
await NodeFSP.writeFile(new URL("./lunora/counter.ts", import.meta.url), functions.source);
