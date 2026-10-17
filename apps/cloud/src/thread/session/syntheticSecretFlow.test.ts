import {
  SYNTHETIC_SECRET_ENVIRONMENT,
  SYNTHETIC_SECRET_NAMES,
} from "@signalbox/runner-protocol/SyntheticSecrets";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { secretsJson } from "@signalbox/runner-protocol/SecretsProtocol";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  makeRunnerSecrets,
  SecretsRegisterError,
} from "../../../../server/src/signalbox/runner/RunnerSecrets.ts";
import { makeSecretMask } from "../../../../server/src/signalbox/runner/secretMask.ts";
import { previewSyntheticSecretsEnabled } from "../../previewSecrets.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { serveEgress } from "../egress/egress.ts";
import { makeEgressDispatch, type EgressDispatchAnswer } from "../egress/egressDispatch.ts";
import { readSecretSources } from "../egress/secretSendTables.ts";
import { connect, freshDatabase, launch, personal, withObject } from "../runner/runnerTestKit.ts";
import { serveSessionRequest } from "./sessionRoutes.ts";

it.effect(
  "loads synthetic values through session registration, model masking and revision-fenced dispatch",
  () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        const environment = OnePasswordEnvironmentId.make(SYNTHETIC_SECRET_ENVIRONMENT);
        yield* launch(engine, "synthetic", {
          ...personal,
          secrets: { top: [environment], projects: {} },
        });
        yield* connect(runner);
        const work = yield* runner.work;
        const runId = work.turn?.runId;
        if (runId === undefined || work.sessions === null) throw new Error("missing test run");
        const store = Context.get(context, ThreadStore);
        const mask = makeSecretMask();
        const secrets = makeRunnerSecrets({
          onePassword: () => Effect.die("synthetic sources must not read 1Password"),
          mask,
          reserved: () => new Set(),
        });
        let registrations = 0;
        const token = work.sessions.token;
        yield* secrets.load(
          {
            token: null,
            environments: work.secrets,
            ...(previewSyntheticSecretsEnabled({
              DEPLOYMENT_STAGE: "pr-656",
              ENVIRONMENT_ID: "cloud-preview-656",
              PREVIEW_SYNTHETIC_SECRETS: "1",
            })
              ? { synthetic: true as const }
              : {}),
            guarded: true,
          },
          {
            notice: () => Effect.void,
            info: () => Effect.void,
            register: (registration) =>
              serveSessionRequest({
                method: "POST",
                url: `https://cloud.test${SESSION_PATHS.secrets}`,
                token,
                body: secretsJson.registration.encode({ ...registration, runId }),
              }).pipe(
                Effect.provide(context),
                Effect.flatMap((answer) => {
                  if (answer.status !== 200)
                    return Effect.fail(
                      new SecretsRegisterError({ message: "test registration failed" }),
                    );
                  registrations++;
                  return Effect.void;
                }),
              ),
          },
        );
        expect(registrations).toBe(1);
        const snapshot = yield* store.secretValues;
        expect(snapshot.current.map(({ name }) => name).toSorted()).toEqual(
          [...SYNTHETIC_SECRET_NAMES].toSorted(),
        );
        expect(snapshot.values.length).toBe(3);
        const sources = yield* readSecretSources.pipe(Effect.provide(context));
        expect([...sources.values()]).toEqual([environment, environment, environment]);
        expect((yield* runner.authorizeModel(work.modelToken ?? "", "anthropic"))._tag).toBe(
          "granted",
        );
        for (const { name, value } of snapshot.current) {
          expect(mask.text(value) === `{{secret:${name}}}`).toBe(true);
          expect(secrets.environment()[name] === value).toBe(true);
        }
        let sent = false;
        const dispatch = yield* makeEgressDispatch({
          send: async () => {
            sent = true;
            return new Response(JSON.stringify(snapshot.current.map(({ value }) => value)), {
              headers: { "content-type": "application/json; charset=windows-1252" },
            });
          },
        }).pipe(Effect.provide(context));
        const requested = Promise.withResolvers<Parameters<typeof dispatch> | null>();
        const dispatched = Promise.withResolvers<EgressDispatchAnswer>();
        const responding = yield* Effect.promise(() =>
          serveEgress(new Request("https://example.test/"), {
            ownHosts: new Set(),
            thread: {
              secrets: async () => snapshot,
              authorize: async () => ({ _tag: "refused", message: "not a secret-bearing request" }),
            },
            dispatch: (request, revision) => {
              requested.resolve([request, revision]);
              return dispatched.promise;
            },
          }).then((response) => {
            requested.resolve(null);
            return response;
          }),
        ).pipe(Effect.forkChild);
        const request = yield* Effect.promise(() => requested.promise);
        if (request === null) throw new Error("the request never reached revision-fenced dispatch");
        dispatched.resolve(yield* dispatch(...request));
        const response = yield* Fiber.join(responding);
        const text = yield* Effect.promise(() => response.text());
        expect(sent).toBe(true);
        for (const { name, value } of snapshot.current) {
          expect(text.includes(value)).toBe(false);
          expect(text.includes(`{{secret:${name}}}`)).toBe(true);
        }
      }),
    ),
);
