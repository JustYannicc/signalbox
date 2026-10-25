export type BunJscMember = "edenGC" | "heapStats";

export class BunJscUnavailableError extends Error {
  readonly code = "ERR_BUN_JSC_UNAVAILABLE";
  readonly runtime = "v8";
  readonly member: BunJscMember;

  constructor(member: BunJscMember) {
    super(`bun:jsc.${member} requires JavaScriptCore`);
    this.name = "BunJscUnavailableError";
    this.member = member;
  }
}

// V8 cannot report JavaScriptCore heap counts or promise its nursery GC semantics.
export function edenGC(): never {
  throw new BunJscUnavailableError("edenGC");
}

export function heapStats(_includeObjectTypeCounts?: boolean): never {
  throw new BunJscUnavailableError("heapStats");
}
