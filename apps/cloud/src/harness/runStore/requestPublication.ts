import type { State } from "./schemas.ts";
import type { RequestCommand } from "./requestSchemas.ts";
import type { Decision } from "./records.ts";
import { fail, same } from "./errors.ts";

type Published = Extract<RequestCommand, { readonly publisher: unknown }>;
export function publishRequest(state: State, command: Published): Decision {
  const mode = state.requests;
  const current = mode?.facets.at(-1);
  if (
    !mode ||
    !current ||
    command.publisher.generation !== current.generation ||
    command.publisher.facetNonce !== current.facetNonce ||
    command.publisher.publisherKey !== current.publisherKey
  )
    return fail("PUBLISHER_DENIED");
  const index = mode.entries.findIndex((entry) => entry.request.requestId === command.requestId);
  const entry = mode.entries[index];
  if (!entry) return fail("MISSING");
  // A committed result can be returned to the replacement facet without reviving its execution.
  if (command.type === "request.admit" && entry.status === "completed")
    return { state, action: "committed" };
  if (command.type === "request.admit" && entry.status === "not-applied")
    return { state, action: "not-applied" };
  if (entry.generation !== current.generation || entry.facetNonce !== current.facetNonce)
    return fail("PUBLISHER_DENIED");
  const update = (
    next: typeof entry,
    action: Decision["action"],
    checkpoint = mode.checkpoint,
  ): Decision => ({
    state: {
      ...state,
      requests: {
        ...mode,
        checkpoint,
        entries: mode.entries.map((row, i) => (i === index ? next : row)),
      },
    },
    action,
  });
  switch (command.type) {
    case "request.admit":
      if (entry.status === "indeterminate") return { state, action: "indeterminate" };
      if (entry.status === "admitted") return { state, action: "observe-only" };
      if (entry.status !== "offered") return fail("CONFLICT");
      return update({ ...entry, status: "admitted" }, "execute-once");
    case "request.check":
      if (entry.status !== "admitted") return fail("CONFLICT");
      return { state, action: "unchanged" };
    case "request.progress":
      if (entry.status !== "admitted") return fail("CONFLICT");
      if (entry.progress?.sequence === command.progress.sequence) {
        if (!same(entry.progress, command.progress)) return fail("CONFLICT");
        return { state, action: "unchanged" };
      }
      if (command.progress.sequence !== (entry.progress?.sequence ?? 0) + 1)
        return fail("OUT_OF_ORDER");
      return update({ ...entry, progress: command.progress }, "recorded");
    case "request.finish":
      if (entry.status === "completed") {
        if (!same(entry.finish, command.finish)) return fail("CONFLICT");
        return { state, action: "committed" };
      }
      if (entry.status !== "admitted") return fail("CONFLICT");
      if (command.finish.sequence !== (entry.progress?.sequence ?? 0) + 1)
        return fail("OUT_OF_ORDER");
      return update(
        { ...entry, status: "completed", finish: command.finish },
        "committed",
        command.finish.checkpoint,
      );
  }
}
