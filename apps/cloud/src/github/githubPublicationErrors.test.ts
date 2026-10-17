import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

import { makeRepositoryPublication } from "./GitHubRepositoryPublication.ts";
import { publicationFixture, USER } from "./githubPublicationTesting.ts";

class InfrastructureFailure extends Data.TaggedError("InfrastructureFailure")<{
  readonly message: string;
}> {}

describe("publication failures", () => {
  it.effect("keeps infrastructure diagnostics out of the public error", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const publish = yield* makeRepositoryPublication(() =>
        Effect.fail(
          new InfrastructureFailure({
            message: "database relation publication_internal is missing",
          }),
        ),
      ).pipe(Effect.provide(f.cloud.layerFor(USER)));
      const error = yield* publish(
        { userId: USER, contextIds: [PERSONAL_CONTEXT_ID] },
        f.input,
      ).pipe(Effect.flip);
      expect(error.detail).toBe("The folder could not be published. Retry to continue.");
      expect(f.creations).toHaveLength(0);
      expect(yield* f.drive.remote()).toBeNull();
    }),
  );

  it.effect("returns a retry message when GitHub's repository read fails", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      f.settings.failAllRepositoryReads = true;
      const error = yield* f.publish().pipe(Effect.flip);
      if (error._tag !== "SourceControlRepositoryError") return expect.unreachable();
      expect(error.detail).toBe("The folder could not be published. Retry to continue.");
      expect(error.detail).not.toContain("Reply lost");
      expect(f.creations).toHaveLength(0);
    }),
  );
});
