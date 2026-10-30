import type { inspectPackagedBuiltinCoverage } from "../nodeBuiltinGate.ts";

/** Qualification preserves gaps as evidence; none of these records grants callable support. */
export function qualificationBuiltinFindings(
  inspected: Awaited<ReturnType<typeof inspectPackagedBuiltinCoverage>>,
) {
  return {
    schemaVersion: 1 as const,
    status: "open" as const,
    sources: inspected.sources.map(({ name, bytes, sha256, sourceUtf16Length }) => ({
      name,
      bytes,
      sha256,
      sourceUtf16Length,
    })),
    missingBuiltins: inspected.missingBuiltins,
    unknownBuiltinSpecifiers: inspected.unknownBuiltinSpecifiers,
    importAmbiguities: inspected.ambiguities,
    calls: inspected.requiredFunctions.filter(
      (call) => call.status !== "supported" && call.status !== "platform-pruned",
    ),
    callAmbiguities: inspected.functionAmbiguities,
  };
}
