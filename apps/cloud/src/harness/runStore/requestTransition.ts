import type { HarnessRunStoreCommand, State } from "./schemas.ts";
import type { Decision } from "./records.ts";
import type { RequestCommand, RequestMode } from "./requestSchemas.ts";
import { fail, same } from "./errors.ts";
import { publishRequest } from "./requestPublication.ts";
import { requestVersion } from "./format.ts";

export const isRequestCommand = (command: HarnessRunStoreCommand): command is RequestCommand =>
  command.type.startsWith("request.");
const unresolved = (entry: RequestMode["entries"][number]) =>
  entry.status === "offered" || entry.status === "admitted" || entry.status === "indeterminate";
const resultAction = (entry: RequestMode["entries"][number]): Decision["action"] => {
  switch (entry.status) {
    case "completed":
      return "committed";
    case "not-applied":
      return "not-applied";
    case "indeterminate":
      return "indeterminate";
    default:
      return "observe-only";
  }
};

export function transitionRequests(state: State, command: RequestCommand): Decision {
  if ("controlKey" in command && command.controlKey !== state.controlKey)
    return fail("STALE_SUPERVISOR");
  const mode = state.requests;
  if (command.type === "request.mode") {
    if (mode) {
      if (mode.modeId !== command.requestId || !same(mode.initialCheckpoint, command.checkpoint))
        return fail("CONFLICT");
      return { state, action: "unchanged" };
    }
    if (state.invocation || state.progress || state.terminal) return fail("CONFLICT");
    return {
      state: {
        ...state,
        version: requestVersion,
        requests: {
          modeId: command.requestId,
          initialCheckpoint: command.checkpoint,
          checkpoint: command.checkpoint,
          facets: [],
          entries: [],
        },
      },
      action: "recorded",
    };
  }
  if (!mode) return fail("CONFLICT");
  const supervisor = state.claims.at(-1);
  if (!supervisor) return fail("CORRUPT");
  const current = mode.facets.at(-1);
  const update = (requests: RequestMode, action: Decision["action"] = "recorded"): Decision => ({
    state: { ...state, requests },
    action,
  });
  switch (command.type) {
    case "request.replaceFacet": {
      const previous = mode.facets.find((facet) => facet.operationId === command.operationId);
      if (previous) {
        if (
          previous.generation !== command.expectedGeneration + 1 ||
          previous.facetNonce !== command.facetNonce ||
          previous.publisherKey !== command.publisherKey
        )
          return fail("CONFLICT");
        if (previous !== current || previous.supervisorEpoch !== supervisor.epoch)
          return fail("STALE_SUPERVISOR");
        return { state, action: "unchanged" };
      }
      if ((current?.generation ?? 0) !== command.expectedGeneration) return fail("CONFLICT");
      if (
        mode.facets.some(
          (facet) =>
            facet.facetNonce === command.facetNonce || facet.publisherKey === command.publisherKey,
        ) ||
        command.publisherKey === state.controlKey ||
        state.claims.some((claim) => claim.supervisorKey === command.publisherKey)
      )
        return fail("CONFLICT");
      if (mode.facets.length >= 64) return fail("LIMIT");
      return update({
        ...mode,
        facets: [
          ...mode.facets,
          {
            generation: command.expectedGeneration + 1,
            operationId: command.operationId,
            facetNonce: command.facetNonce,
            publisherKey: command.publisherKey,
            supervisorEpoch: supervisor.epoch,
            checkpoint: mode.checkpoint,
          },
        ],
        entries: mode.entries.map((entry) =>
          unresolved(entry) ? { ...entry, status: "indeterminate" } : entry,
        ),
      });
    }
    case "request.offer": {
      const previous = mode.entries.find(
        (entry) => entry.request.requestId === command.request.requestId,
      );
      if (previous) {
        if (!same(previous.request, command.request)) return fail("CONFLICT");
        return { state, action: resultAction(previous) };
      }
      if (!current || current.supervisorEpoch !== supervisor.epoch) return fail("STALE_SUPERVISOR");
      if (mode.entries.some(unresolved)) return fail("CONFLICT");
      if (mode.entries.length >= 128) return fail("LIMIT");
      return update({
        ...mode,
        entries: [
          ...mode.entries,
          {
            request: command.request,
            generation: current.generation,
            facetNonce: current.facetNonce,
            status: "offered",
            progress: null,
            finish: null,
            reconciliation: null,
          },
        ],
      });
    }
    case "request.reconcile": {
      const index = mode.entries.findIndex(
        (entry) => entry.request.requestId === command.requestId,
      );
      const entry = mode.entries[index];
      if (!entry) return fail("MISSING");
      const reconciliation = { evidence: command.evidence, outcome: command.outcome };
      if (entry.reconciliation && same(entry.reconciliation, reconciliation))
        return { state, action: resultAction(entry) };
      if (entry.status === "completed" || entry.status === "not-applied") return fail("CONFLICT");
      // Reconciliation cannot release a still-current publisher's admitted work.
      if (entry.status !== "indeterminate" || !current || entry.generation === current.generation)
        return fail("CONFLICT");
      let next: typeof entry;
      switch (command.outcome.type) {
        case "unknown":
          next = { ...entry, reconciliation };
          break;
        case "not-applied":
          next = { ...entry, reconciliation, status: "not-applied" };
          break;
        case "completed":
          next = {
            ...entry,
            reconciliation,
            status: "completed",
            finish: {
              sequence: (entry.progress?.sequence ?? 0) + 1,
              status: command.outcome.status,
              result: command.outcome.result,
              checkpoint: command.outcome.checkpoint,
            },
          };
          break;
      }
      const entries = mode.entries.map((row, i) => (i === index ? next : row));
      return update(
        { ...mode, entries, checkpoint: next.finish?.checkpoint ?? mode.checkpoint },
        resultAction(next),
      );
    }
    default:
      return publishRequest(state, command);
  }
}
