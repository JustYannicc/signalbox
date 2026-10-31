import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SourceProviderError, resolveSource, type WorkerSourceModule } from "alchemy/Cloudflare";
import { readStartupEvidence } from "./evidence.ts";

const Options = Schema.Struct({
  main: Schema.String,
  rules: Schema.Array(Schema.Struct({ globs: Schema.Array(Schema.String) })),
});
const decodeOptions = Schema.decodeUnknownEffect(Options);
const provider = "signalbox/worker-startup";
const failure = (cause: unknown) =>
  new SourceProviderError({
    provider,
    message: "The exact Worker startup gate did not pass",
    cause,
  });

/** Deployment always verifies the final byte-preserved modules, including no-change plans. */
export default {
  make: (raw) =>
    Effect.gen(function* () {
      const options = yield* decodeOptions(raw).pipe(Effect.mapError(failure));
      const source = yield* resolveSource({
        main: options.main,
        rules: options.rules.map((rule) => ({ globs: [...rule.globs] })),
        bundle: false,
      });
      const build: typeof source.build = (context) =>
        source.build(context).pipe(
          Effect.tap((output) =>
            Effect.tryPromise({
              try: async () => {
                if (!output.bundle) throw new Error("WORKER_STARTUP_BUNDLE_MISSING");
                await readStartupEvidence(options.main, output.bundle, context.compatibility);
              },
              catch: failure,
            }),
          ),
        );
      const hash: typeof source.hash = (context) =>
        build(context).pipe(Effect.map((output) => output.hash));
      return {
        ...source,
        build,
        hash,
      };
    }),
} satisfies WorkerSourceModule;
