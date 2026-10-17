import {
  SYNTHETIC_SECRET_ENVIRONMENT,
  SYNTHETIC_SECRET_NAMES,
} from "@signalbox/runner-protocol/SyntheticSecrets";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { secretsJson } from "@signalbox/runner-protocol/SecretsProtocol";
import {
  hasSyntheticSecretsRegistrationShape,
  syntheticSecretsRegistrationFixture,
} from "@signalbox/runner-protocol/testing/SecretsFixture";
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretPlaceholders";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { serveEgress } from "../Egress.ts";
import { makeEgressDispatch, type EgressDispatchAnswer } from "../EgressDispatch.ts";
import { serveSessionRequest } from "../SessionRoutes.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { readSecretSources } from "../secretRegistrationTesting.ts";
import { connect, freshDatabase, launch, personal, withObject } from "../runnerTesting.ts";

it.effect(
  "accepts the synthetic runner registration through session registration and revision-fenced dispatch",
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
        const token = work.sessions.token;
        const store = Context.get(context, ThreadStore);
        const register = (generation: 0 | 1) => {
          const registration = syntheticSecretsRegistrationFixture(runId, generation);
          expect(hasSyntheticSecretsRegistrationShape(registration)).toBe(true);
          expect(
            secretsJson.registration.decode(secretsJson.registration.encode(registration)),
          ).toEqual(registration);
          return serveSessionRequest({
            method: "POST",
            url: `https://cloud.test${SESSION_PATHS.secrets}`,
            token,
            body: secretsJson.registration.encode(registration),
          }).pipe(Effect.provide(context));
        };
        let registrations = 0;
        const initialRegistration = syntheticSecretsRegistrationFixture(runId, 0);
        const initial = yield* register(0);
        registrations++;
        expect(initial.status).toBe(200);
        const first = yield* store.secretValues;
        expect(first.current).toEqual(initialRegistration.current);
        expect(first.values).toEqual(initialRegistration.secrets);
        expect(first.registeredRunId).toBe(runId);
        const rotatedRegistration = syntheticSecretsRegistrationFixture(runId, 1);
        const rotation = yield* register(1);
        registrations++;
        expect(rotation.status).toBe(200);
        const snapshot = yield* store.secretValues;
        expect(registrations).toBe(2);
        expect(snapshot.current.map(({ name }) => name).toSorted()).toEqual(
          [...SYNTHETIC_SECRET_NAMES].toSorted(),
        );
        expect(snapshot.current).toEqual(rotatedRegistration.current);
        expect(snapshot.values).toEqual([
          ...initialRegistration.secrets,
          ...rotatedRegistration.secrets,
        ]);
        expect(snapshot.values).toHaveLength(6);
        expect(
          snapshot.current.every(({ value }) =>
            initialRegistration.current.every((previous) => previous.value !== value),
          ),
        ).toBe(true);
        expect(snapshot.registeredRunId).toBe(runId);
        expect(snapshot.revision).toBe(first.revision + 1);
        const sources = yield* readSecretSources.pipe(Effect.provide(context));
        expect([...sources.values()]).toEqual([environment, environment, environment]);
        expect([...sources.entries()]).toEqual(
          SYNTHETIC_SECRET_NAMES.map((name) => [name, environment]),
        );
        expect((yield* runner.authorizeModel(work.modelToken ?? "", "anthropic"))._tag).toBe(
          "granted",
        );
        let sent = false;
        const dispatch = yield* makeEgressDispatch({
          send: async () => {
            sent = true;
            return new Response(JSON.stringify(snapshot.values.map(({ value }) => value)), {
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
        expect(request[1]).toBe(snapshot.revision);
        dispatched.resolve(yield* dispatch(...request));
        const response = yield* Fiber.join(responding);
        const text = yield* Effect.promise(() => response.text());
        expect(sent).toBe(true);
        expect(text).toBe(
          JSON.stringify(snapshot.values.map(({ name }) => secretPlaceholder(name))),
        );
        for (const { value } of snapshot.values) {
          expect(text.includes(value)).toBe(false);
        }
      }),
    ),
);
