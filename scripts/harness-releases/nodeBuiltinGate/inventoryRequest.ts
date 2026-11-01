import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { captureRuntimeBuiltinInventory } from "../runtimeBuiltinInventory.ts";
import type { scanBuiltinSource } from "./source.ts";

const Request = Schema.Struct({
  schema: Schema.Literal("signalbox/builtin-inventory-request/v1"),
  sources: Schema.Array(
    Schema.Struct({ name: Schema.String, bytes: Schema.Int, sha256: Schema.String }),
  ),
  functions: Schema.Array(
    Schema.Struct({ specifier: Schema.String, memberPath: Schema.Array(Schema.String) }),
  ),
});
const decodeRequest = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" });

export function createBuiltinInventoryRequest(
  sources: readonly ReturnType<typeof scanBuiltinSource>[],
) {
  const functions = new Map<string, { specifier: string; memberPath: readonly string[] }>();
  for (const source of sources)
    for (const call of source.requiredFunctions) {
      const specifier = call.specifier.replace(/^node:/, "");
      functions.set(JSON.stringify([specifier, call.memberPath]), {
        specifier,
        memberPath: call.memberPath,
      });
    }
  return {
    schema: "signalbox/builtin-inventory-request/v1" as const,
    sources: sources.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    functions: [...functions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v),
  };
}

export const builtinInventoryRequestSha256 = (request: typeof Request.Type) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");

/** The runtime stage consumes the analysis result without loading or linking provider code. */
export async function captureBuiltinInventoryRequest(value: unknown, sha256: string) {
  const request = decodeRequest(value);
  if (builtinInventoryRequestSha256(request) !== sha256)
    throw new Error("NODE_BUILTIN_INVENTORY_REQUEST_CHANGED");
  const inventory = await captureRuntimeBuiltinInventory(request.functions);
  return {
    ...inventory,
    capture: { ...inventory.capture, inventoryRequestSha256: sha256 },
  };
}
