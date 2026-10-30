import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";

export function gateClaudeSdkResults(
  query: ClaudeSdkQuery,
  assertCompatibility: () => Promise<void>,
): ClaudeSdkQuery {
  let guardedQuery: ClaudeSdkQuery;
  guardedQuery = new Proxy(query, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => guardedQuery;
      if (property === "initializationResult")
        return async () => {
          const result = await target.initializationResult();
          await assertCompatibility();
          return result;
        };
      if (property === "next")
        return async (...args: Parameters<ClaudeSdkQuery["next"]>) => {
          const result = await target.next(...args);
          if (result.done || result.value.type === "result") await assertCompatibility();
          return result;
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return guardedQuery;
}
