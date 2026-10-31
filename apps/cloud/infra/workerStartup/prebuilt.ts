import { NodeServices } from "@effect/platform-node";
import * as Artifacts from "alchemy/Artifacts";
import { resolveSource } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { StartupCompatibility } from "./payload.ts";

/** A fresh artifact scope reads the prebuilt files again, without evaluating or compiling them. */
export function readStartupBundle(
  options: {
    readonly main: string;
    readonly rules: readonly { readonly globs: readonly string[] }[];
  },
  compatibility: StartupCompatibility,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* resolveSource({
        main: options.main,
        rules: options.rules.map((rule) => ({ globs: [...rule.globs] })),
        bundle: false,
      });
      const output = yield* source.build({
        id: "startup-profile",
        fqn: "startup-profile",
        workerName: "startup-profile",
        compatibility: { date: compatibility.date, flags: [...compatibility.flags] },
        entry: { kind: "external" },
        stack: { name: "startup-profile", stage: "local" },
        env: undefined,
        extraOptions: undefined,
        assets: undefined,
      });
      if (!output.bundle) return yield* Effect.die(new Error("WORKER_STARTUP_BUNDLE_MISSING"));
      return output.bundle;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(
            Artifacts.Artifacts,
            Artifacts.makeScopedArtifacts(Artifacts.createArtifactStore(), "startup-profile"),
          ),
        ),
      ),
    ),
  );
}
