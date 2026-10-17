import * as Effect from "effect/Effect";
import { SourceControlProviderKind, SourceControlRepositoryError } from "@t3tools/contracts";

import { GitHub } from "./GitHub.ts";
import { GitHubConnection } from "./GitHubConnection.ts";

const fail = (detail: string) =>
  new SourceControlRepositoryError({
    provider: SourceControlProviderKind.make("github"),
    operation: "publishRepository",
    detail,
  });

// Publication acts as the requesting person; later pushes can use folder identities (#289).
export const publicationIdentity = Effect.gen(function* () {
  const connection = yield* GitHubConnection;
  const github = yield* GitHub;
  const token = yield* connection.accessToken.pipe(
    Effect.mapError(() => fail("GitHub is unreachable right now.")),
  );
  if (token === null) return yield* fail("Connect GitHub to publish this folder.");
  const viewer = yield* github.api
    .viewer(token)
    .pipe(Effect.mapError((error) => fail(error.message)));
  if (viewer === null) return yield* fail("Reconnect GitHub to publish this folder.");
  return { token, id: viewer.id, login: viewer.login };
});
