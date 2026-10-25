import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type GitHubApi, GitHubError, unreadable } from "./GitHubApi.ts";

const PAGE_SIZE = 100;
const MAX_HOOK_PAGES = 10;

const Hook = Schema.Struct({
  id: Schema.Number,
  config: Schema.Struct({ url: Schema.optional(Schema.String) }),
});
const HookList = Schema.Array(Hook);
const HookId = Schema.Struct({ id: Schema.Number });

const decoded = <A>(operation: string, schema: Schema.Codec<A, unknown>, text: string | null) => {
  if (text === null)
    return Effect.fail(
      new GitHubError({
        operation,
        status: 404,
        message: "GitHub could not find that repository web hook.",
      }),
    );
  return Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), {
    onNone: () => Effect.fail(unreadable(operation)),
    onSome: Effect.succeed,
  });
};

/** GitHub repository web hooks, scoped to one exact callback URL. */
export const makeGitHubHookApi = (api: GitHubApi) => {
  const hooksPath = (repository: string) => `/repos/${repository}/hooks`;

  const list = (token: string, repository: string) =>
    Effect.gen(function* () {
      const hooks: Array<typeof Hook.Type> = [];
      for (let page = 1; page <= MAX_HOOK_PAGES; page++) {
        const text = yield* api.rest("githubHooks.list", token, hooksPath(repository), {
          per_page: String(PAGE_SIZE),
          page: String(page),
        });
        const pageHooks = yield* decoded("githubHooks.list", HookList, text);
        hooks.push(...pageHooks);
        if (pageHooks.length < PAGE_SIZE) return hooks;
      }
      return yield* new GitHubError({
        operation: "githubHooks.list",
        status: 200,
        message: "GitHub's repository web hook list is too large to read completely.",
      });
    });

  const body = (input: {
    readonly url: string;
    readonly secret: string;
    readonly events: ReadonlyArray<string>;
  }) => ({
    name: "web",
    active: true,
    events: input.events,
    config: {
      url: input.url,
      content_type: "json",
      secret: input.secret,
      insecure_ssl: "0",
    },
  });

  return {
    /** Finds by exact URL before creating, so retrying after an uncertain create updates it. */
    ensure: (
      token: string,
      repository: string,
      input: {
        readonly url: string;
        readonly secret: string;
        readonly events: ReadonlyArray<string>;
      },
    ) =>
      Effect.gen(function* () {
        const existing = (yield* list(token, repository)).find(
          (hook) => hook.config.url === input.url,
        );
        if (existing === undefined) {
          const text = yield* api.post(
            "githubHooks.create",
            token,
            hooksPath(repository),
            body(input),
          );
          const created = yield* decoded("githubHooks.create", HookId, text);
          return created.id;
        }

        const text = yield* api.patch(
          "githubHooks.update",
          token,
          `${hooksPath(repository)}/${existing.id}`,
          body(input),
        );
        const updated = yield* decoded("githubHooks.update", HookId, text);
        return updated.id;
      }),

    /** GitHub returns 404 for a hook already removed; deletion stays idempotent. */
    remove: (token: string, repository: string, hookId: number) =>
      api
        .delete("githubHooks.delete", token, `${hooksPath(repository)}/${hookId}`)
        .pipe(Effect.asVoid),
  };
};
