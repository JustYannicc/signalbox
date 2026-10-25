import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { verifyRunnerPublication } from "./runnerImagePublication.ts";

const imageId = `sha256:${"a".repeat(64)}`;
const image = "ghcr.io/justyannicc/signalbox-runner";

it.effect("accepts channel and immutable tags when both name the tested image", () =>
  Effect.gen(function* () {
    const result = yield* verifyRunnerPublication(
      { references: [`${image}:nightly`, `${image}:nightly-20261018-aabbccddeeff`], imageId },
      () => Effect.succeed({ Id: imageId }),
    );
    expect(result).toEqual([
      { name: image, tag: "nightly" },
      { name: image, tag: "nightly-20261018-aabbccddeeff" },
    ]);
  }),
);

it.effect("rejects the whole publication when one tag names an older build", () =>
  Effect.gen(function* () {
    const result = yield* verifyRunnerPublication(
      { references: [`${image}:1.2.3`, `${image}:stable`], imageId },
      (reference) =>
        Effect.succeed({
          Id: reference.endsWith(":stable") ? `sha256:${"b".repeat(64)}` : imageId,
        }),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
  }),
);

it.effect("does not inspect or publish malformed refs or a missing build identity", () =>
  Effect.gen(function* () {
    for (const input of [
      { references: [], imageId },
      { references: [`${image}:nightly`, "other/runner:nightly"], imageId },
      { references: [`${image}:nightly`, ""], imageId },
      { references: [`${image}:nightly`], imageId: "" },
    ]) {
      let inspected = false;
      const result = yield* verifyRunnerPublication(input, () => {
        inspected = true;
        return Effect.succeed({ Id: imageId });
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(inspected).toBe(false);
    }
  }),
);

it.effect("propagates a missing local image instead of allowing a registry pull", () =>
  Effect.gen(function* () {
    const failure = new Error("local image missing");
    const result = yield* verifyRunnerPublication(
      { references: [`${image}:pr-404`], imageId },
      () => Effect.fail(failure),
    ).pipe(Effect.flip);
    expect(result).toBe(failure);
  }),
);
