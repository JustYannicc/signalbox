// @effect-diagnostics nodeBuiltinImport:off -- Alchemy's Node-only stack entry reads its generated binding manifest before deploy.
import * as NodeFSP from "node:fs/promises";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toAlchemyBindings } from "../syncBindings.ts";

const classExports = {
  SyncProbeShard: true,
} satisfies Partial<Record<keyof typeof import("./worker.ts"), true>>;

const here = (path: string) => `${import.meta.dirname}/${path}`;
const decodeManifestJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readManifest = Effect.gen(function* () {
  const manifestText = yield* Effect.promise(() =>
    NodeFSP.readFile(here("binding-manifest.json"), "utf8"),
  );
  const manifest: unknown = yield* decodeManifestJson(manifestText).pipe(Effect.orDie);
  if (
    !isRecord(manifest) ||
    typeof manifest.compatibilityDate !== "string" ||
    !Array.isArray(manifest.compatibilityFlags) ||
    !manifest.compatibilityFlags.every((flag) => typeof flag === "string") ||
    !Array.isArray(manifest.crons) ||
    manifest.crons.length > 0 ||
    !Array.isArray(manifest.vars) ||
    manifest.vars.length > 0
  ) {
    throw new Error(
      "The generated Lunora BindingManifest has unsupported Worker settings, crons, or vars.",
    );
  }
  return {
    bindings: toAlchemyBindings(manifest, classExports),
    compatibility: {
      date: manifest.compatibilityDate,
      flags: manifest.compatibilityFlags,
    },
  };
});

export default Alchemy.Stack(
  "SignalboxSyncProbe",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (!/^pr-[1-9]\d*$/.test(stage)) {
      throw new Error(`The sync probe only deploys isolated pr-N stages; got "${stage}".`);
    }

    const { bindings, compatibility } = yield* readManifest;
    const probeSecret = yield* Config.Redacted("PROBE_SECRET");
    const worker = yield* Cloudflare.Worker("SyncProbe", {
      name: `signalbox-sync-probe-${stage}`,
      main: here("worker.ts"),
      compatibility,
      workersDev: { enabled: false, previewsEnabled: true },
      env: {
        PROBE_SECRET: probeSecret,
        ...bindings,
      },
    });
    if (worker.url === undefined) {
      throw new Error("Alchemy did not return a Worker preview URL for the sync probe.");
    }

    return { stage, worker: worker.workerName, url: worker.url };
  }),
);
