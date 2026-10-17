import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import { secretsJson } from "@signalbox/runner-protocol/SecretsProtocol";
import { SYNTHETIC_SECRET_ENVIRONMENT } from "@signalbox/runner-protocol/SyntheticSecrets";
import {
  syntheticSecretsEchoFixture,
  syntheticSecretsRegistrationFixture,
} from "@signalbox/runner-protocol/testing/SecretsFixture";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { REFUSED_HEADER } from "../Egress.ts";
import { serveSessionRequest } from "../SessionRoutes.ts";
import { ThreadStore } from "../ThreadStore.ts";
import { connect, freshDatabase, launch, personal, withObject } from "../runnerTesting.ts";
import { serveWithFakeNetwork } from "../tests/egressTestKit.ts";

it.effect(
  "accepts a runner registration, redacts an authorized echo, and refuses an unapproved echo",
  () =>
    withObject(freshDatabase(), (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine, "secret-echo", {
          ...personal,
          secrets: {
            top: [OnePasswordEnvironmentId.make(SYNTHETIC_SECRET_ENVIRONMENT)],
            projects: {},
          },
        });
        yield* connect(runner);
        const work = yield* runner.work;
        const runId = work.turn?.runId;
        if (runId === undefined || work.sessions === null) throw new Error("missing test run");
        const registration = syntheticSecretsRegistrationFixture(runId);
        const answer = yield* serveSessionRequest({
          method: "POST",
          url: `https://cloud.test${SESSION_PATHS.secrets}`,
          token: work.sessions.token,
          body: secretsJson.registration.encode(registration),
        }).pipe(Effect.provide(context));
        expect(answer.status).toBe(200);

        const secrets = yield* Context.get(context, ThreadStore).secretValues;
        const echo = syntheticSecretsEchoFixture(registration);
        const sent: Array<string> = [];
        const asked: Array<{ host: string; names: ReadonlyArray<string> }> = [];
        const request = () =>
          new Request("https://approved.example/use", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: echo.placeholder,
          });
        const response = yield* Effect.promise(() =>
          serveWithFakeNetwork(request(), {
            ownHosts: new Set(),
            thread: {
              secrets: async () => secrets,
              authorize: async ({ host, names }) => {
                asked.push({ host, names });
                return { _tag: "allowed" };
              },
            },
            send: async (outgoing) => {
              const text = await outgoing.text();
              sent.push(text);
              return new Response(text, { headers: { "content-type": "text/plain" } });
            },
          }),
        );
        expect(response.status).toBe(200);
        expect(asked).toEqual([
          { host: "approved.example", names: registration.current.map(({ name }) => name) },
        ]);
        expect(sent).toEqual([echo.resolved]);
        const echoed = yield* Effect.promise(() => response.text());
        expect(echoed).toBe(echo.placeholder);
        for (const { value } of registration.current) expect(echoed).not.toContain(value);

        const refused = yield* Effect.promise(() =>
          serveWithFakeNetwork(request(), {
            ownHosts: new Set(),
            thread: {
              secrets: async () => secrets,
              authorize: async () => ({ _tag: "refused", message: "not approved" }),
            },
            send: async (outgoing) => {
              sent.push(await outgoing.text());
              return new Response("unexpected");
            },
          }),
        );
        const refusal = yield* Effect.promise(() => refused.text());
        expect(refused.status).toBe(403);
        expect(refused.headers.get(REFUSED_HEADER)).toBe("secret");
        expect(refusal).toContain("not approved");
        expect(sent).toEqual([echo.resolved]);
        for (const { value } of registration.current) expect(refusal).not.toContain(value);
      }),
    ),
);
