import type { State } from "./schemas.ts";
import { fail, same } from "./errors.ts";

export function validateRequests(state: State) {
  const mode = state.requests;
  if (!mode) return;
  if (state.invocation || state.progress || state.terminal) return fail("CORRUPT");
  const epoch = state.claims.at(-1)?.epoch ?? 0;
  const current = mode.facets.at(-1);
  if (
    mode.facets.some(
      (facet, i) =>
        facet.generation !== i + 1 ||
        facet.supervisorEpoch > epoch ||
        facet.publisherKey === state.controlKey ||
        state.claims.some((claim) => claim.supervisorKey === facet.publisherKey),
    )
  )
    return fail("CORRUPT");
  for (const field of ["operationId", "facetNonce", "publisherKey"] as const) {
    if (new Set(mode.facets.map((facet) => facet[field])).size !== mode.facets.length)
      return fail("CORRUPT");
  }
  if (new Set(mode.entries.map((entry) => entry.request.requestId)).size !== mode.entries.length)
    return fail("CORRUPT");
  let unresolved = 0;
  for (const [index, entry] of mode.entries.entries()) {
    const facet = mode.facets[entry.generation - 1];
    if (!facet || facet.facetNonce !== entry.facetNonce) return fail("CORRUPT");
    if (
      entry.status === "offered" ||
      entry.status === "admitted" ||
      entry.status === "indeterminate"
    ) {
      unresolved++;
      if (index !== mode.entries.length - 1) return fail("CORRUPT");
    }
    if ((entry.status === "offered" || entry.status === "admitted") && facet !== current)
      return fail("CORRUPT");
    if ((entry.status === "indeterminate" || entry.reconciliation) && facet === current)
      return fail("CORRUPT");
    if (entry.status === "offered" && entry.progress) return fail("CORRUPT");
    if ((entry.status === "completed") !== (entry.finish !== null)) return fail("CORRUPT");
    if (entry.finish && entry.finish.sequence !== (entry.progress?.sequence ?? 0) + 1)
      return fail("CORRUPT");
    const outcome = entry.reconciliation?.outcome;
    if (entry.status === "not-applied" && outcome?.type !== "not-applied") return fail("CORRUPT");
    if (outcome?.type === "unknown" && entry.status !== "indeterminate") return fail("CORRUPT");
    if (outcome?.type === "not-applied" && entry.status !== "not-applied") return fail("CORRUPT");
    if (
      outcome?.type === "completed" &&
      (!entry.finish ||
        entry.finish.status !== outcome.status ||
        !same(entry.finish.result, outcome.result) ||
        !same(entry.finish.checkpoint, outcome.checkpoint))
    )
      return fail("CORRUPT");
  }
  if (unresolved > 1) return fail("CORRUPT");
  const latest = mode.entries.findLast((entry) => entry.status === "completed");
  if (!same(mode.checkpoint, latest?.finish?.checkpoint ?? mode.initialCheckpoint))
    return fail("CORRUPT");
}
