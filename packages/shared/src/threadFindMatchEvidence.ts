import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type { OrchestrationV2ThreadFindMatchEvidence } from "@t3tools/contracts";
import { findThreadSearchOccurrences } from "./threadSearch.ts";

export interface ThreadFindEvidenceDocument {
  readonly source: string;
  readonly segments: readonly { readonly text: string }[];
}

function documentId(document: ThreadFindEvidenceDocument): string {
  // JSON preserves segment boundaries and lone surrogates across runtimes.
  return bytesToHex(
    sha256(JSON.stringify([1, document.source, document.segments.map((s) => s.text)])),
  );
}

function occurrenceRange(document: ThreadFindEvidenceDocument, query: string, occurrence: number) {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0 || query.length === 0) return null;
  let remaining = occurrence;
  for (const [segmentIndex, segment] of document.segments.entries()) {
    const offsets = findThreadSearchOccurrences(segment.text, query);
    const start = offsets[remaining];
    if (start !== undefined) return { segmentIndex, start, end: start + query.length };
    remaining -= offsets.length;
  }
  return null;
}

export function createThreadFindMatchEvidence(
  document: ThreadFindEvidenceDocument,
  query: string,
  occurrence: number,
): OrchestrationV2ThreadFindMatchEvidence | null {
  const range = occurrenceRange(document, query, occurrence);
  return range === null ? null : { version: 1, documentId: documentId(document), ...range };
}

export function verifyThreadFindMatchEvidence(
  document: ThreadFindEvidenceDocument,
  query: string,
  occurrence: number,
  evidence: OrchestrationV2ThreadFindMatchEvidence | null | undefined,
) {
  if (!evidence || evidence.version !== 1) return null;
  const range = occurrenceRange(document, query, occurrence);
  return range !== null &&
    range.segmentIndex === evidence.segmentIndex &&
    range.start === evidence.start &&
    range.end === evidence.end &&
    documentId(document) === evidence.documentId
    ? range
    : null;
}
