// oxlint-disable-next-line typescript/triple-slash-reference -- Carry OXC helper types to consumers without a runtime import.
/// <reference path="./oxcHelpers.d.ts" />
import keys from "oxc-parser/src-js/generated/visit/keys";

// OXC 0.154 exports this generated table, but documents only the Node entrypoint.
// Workerd uses this pinned table without loading NAPI through the Node entrypoint.
export const visitorKeysOf = (type: string): ReadonlyArray<string> | undefined =>
  keys[type as keyof typeof keys];
