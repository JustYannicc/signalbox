import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { verifyRunnerPublication } from "./runnerImagePublication.ts";

export default Alchemy.Stack(
  "SignalboxRunnerImages",
  {
    providers: Docker.providers(),
    // Publication is a CI artifact operation. No remote resource is destroyed,
    // and every fresh job must publish its own smoke-tested build.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const docker = yield* Docker.Docker;
    const images = yield* verifyRunnerPublication(
      {
        references: (yield* Config.String("TAGS")).split(","),
        imageId: yield* Config.String("RUNNER_IMAGE_ID"),
      },
      docker.image.inspect,
    ).pipe(Effect.orDie);
    const registry = {
      server: "ghcr.io",
      username: yield* Config.String("GITHUB_ACTOR"),
      password: yield* Config.Redacted("GITHUB_TOKEN"),
    };
    return yield* Effect.forEach(images, ({ name, tag }) =>
      Docker.RemoteImage(tag, {
        name,
        tag,
        alwaysPull: false,
        platform: "linux/amd64",
        registry,
      }).pipe(
        Alchemy.RemovalPolicy.retain(),
        Effect.map((image) => image.imageRef),
      ),
    );
  }),
);
