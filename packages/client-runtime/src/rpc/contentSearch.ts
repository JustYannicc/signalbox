import {
  type ProjectSearchContentsInput,
  type ProjectSearchContentsResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "./client.ts";

/** A scan page can be empty while there are still eligible files left to search. */
export const collectContentSearch = <E, R>(
  input: ProjectSearchContentsInput,
  search: (input: ProjectSearchContentsInput) => Effect.Effect<ProjectSearchContentsResult, E, R>,
  emit: (result: ProjectSearchContentsResult) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    const seen = new Set<string>();
    let cursor = input.cursor;
    let regexFallbackError: string | undefined;
    let truncated = false;
    do {
      const page = yield* search({ ...input, ...(cursor === undefined ? {} : { cursor }) });
      matches.push(...page.matches);
      regexFallbackError ??= page.regexFallbackError;
      truncated = page.truncated || matches.length > input.limit;
      cursor = page.nextCursor;
      const result: ProjectSearchContentsResult = {
        matches: matches.slice(0, input.limit),
        truncated,
        ...(regexFallbackError === undefined ? {} : { regexFallbackError }),
      };
      if (cursor === undefined || matches.length >= input.limit) return result;
      // A broken server must not keep a query running on the same position forever.
      if (seen.has(cursor)) return { ...result, truncated: true };
      seen.add(cursor);
      yield* emit(result);
    } while (true);
  });

export const searchProjectContents = (
  input: ProjectSearchContentsInput,
  emit: (result: ProjectSearchContentsResult) => Effect.Effect<void>,
) => collectContentSearch(input, (page) => request(WS_METHODS.projectsSearchContents, page), emit);
