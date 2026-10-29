import { tailDigest } from "./LocalTailCapture.fixture.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep the enclosing bytes intact. Only validated forwarded TraceItems enter coverage. */
export async function decodeNestedTailRecords<
  T extends { readonly key: string; readonly raw: string },
>(records: readonly T[]) {
  return await Promise.all(
    records.map(async (record) => {
      const outer: unknown = JSON.parse(record.raw);
      if (!Array.isArray(outer)) throw new Error("Outer Tail batch is not an array");
      const decodedItems: Record<string, unknown>[] = [];
      const nestedEvidence: { outerKey: string; bytes: number; sha256: string }[] = [];
      for (const item of outer) {
        if (!object(item)) throw new Error("Outer Tail item is not an object");
        for (const log of Array.isArray(item.logs) ? item.logs : []) {
          if (!object(log)) continue;
          const args = Array.isArray(log.message) ? log.message : [log.message];
          for (const arg of args) {
            if (typeof arg !== "string") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(arg);
            } catch {
              continue;
            }
            if (!object(parsed) || !("qualifierRawTrace" in parsed)) continue;
            const wrapper = parsed.qualifierRawTrace;
            if (
              !object(wrapper) ||
              typeof wrapper.raw !== "string" ||
              typeof wrapper.bytes !== "number" ||
              !Number.isSafeInteger(wrapper.bytes) ||
              wrapper.bytes < 1 ||
              wrapper.bytes >= 96 * 1024 ||
              new TextEncoder().encode(wrapper.raw).length !== wrapper.bytes ||
              typeof wrapper.sha256 !== "string" ||
              !/^[a-f0-9]{64}$/.test(wrapper.sha256) ||
              (await tailDigest(wrapper.raw)) !== wrapper.sha256
            )
              throw new Error("Invalid nested Tail raw byte proof");
            const decoded: unknown = JSON.parse(wrapper.raw);
            if (
              !object(decoded) ||
              !Array.isArray(decoded.logs) ||
              decoded.logs.some(
                (log) =>
                  !object(log) ||
                  !Array.isArray(log.message) ||
                  log.message.some((arg) => typeof arg !== "string"),
              )
            )
              throw new Error("Invalid nested TraceItem shape");
            decodedItems.push(decoded);
            nestedEvidence.push({
              outerKey: record.key,
              bytes: wrapper.bytes,
              sha256: wrapper.sha256,
            });
          }
        }
      }
      return { ...record, decodedItems, nestedEvidence };
    }),
  );
}
