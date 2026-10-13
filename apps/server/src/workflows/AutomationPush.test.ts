import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type AutomationNotice } from "@t3tools/contracts";
import { RELAY_AUTOMATION_NOTIFICATION_TYP } from "@t3tools/contracts/relay";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AutomationPush from "./AutomationPush.ts";
import { WorkflowEngine } from "./WorkflowEngine.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const notice = (id: string, importance: AutomationNotice["importance"]): AutomationNotice => ({
  id,
  kind: "notify",
  automationId: "automation_1",
  runId: "run_1",
  stepKey: id,
  title: "Triage Sentry",
  body: `message ${id}`,
  importance,
  at: "2026-10-06T09:00:00.000Z",
});

it.effect("publishes notices to the linked relay, skipping low ones and unlinked servers", () =>
  Effect.gen(function* () {
    const encode = (value: string) => new TextEncoder().encode(value);
    const secrets = new Map<string, Uint8Array>();
    // The credential is the last link secret a push reads, so this marks a finished link check.
    const linkChecked = yield* Deferred.make<void>();
    const store = ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.sync(() => {
          const value = Option.fromUndefinedOr(secrets.get(name));
          if (name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET) {
            Deferred.doneUnsafe(linkChecked, Effect.void);
          }
          return value;
        }),
      create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
      getOrCreateRandom: () => Effect.die("unused"),
    });
    const notices = yield* PubSub.unbounded<AutomationNotice>();
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const published = yield* Deferred.make<void>();
    const fetch: typeof globalThis.fetch = Object.assign(
      (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const body = init?.body;
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: decodeJson(
            typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array),
          ),
        });
        Deferred.doneUnsafe(published, Effect.void);
        return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
      },
      { preconnect: () => {} },
    );

    yield* AutomationPush.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(WorkflowEngine)({
            validate: () => ({ ok: false, diagnostics: [] }),
            subscribeNotices: PubSub.subscribe(notices).pipe(Effect.map(Stream.fromSubscription)),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
          }),
          Layer.succeed(ServerSecretStore.ServerSecretStore, store),
          NodeCrypto.layer,
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

    // Not linked yet: nothing leaves the server.
    yield* PubSub.publish(notices, notice("unlinked", "normal"));
    yield* Deferred.await(linkChecked);
    secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, encode("true"));
    secrets.set(RELAY_URL_SECRET, encode("https://relay.example.test"));
    secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("credential-1"));
    // Notices are handled in order, so the first request proves the two before it sent nothing.
    yield* PubSub.publish(notices, notice("quiet", "low"));
    yield* PubSub.publish(notices, notice("loud", "normal"));
    yield* Deferred.await(published);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(
      "https://relay.example.test/v1/environments/env-1/automation-notifications",
    );
    expect(request?.authorization).toBe("Bearer credential-1");
    const body = request?.body as { notification: unknown; proof: string };
    expect(body.notification).toEqual({
      id: "loud",
      kind: "notify",
      title: "Triage Sentry",
      body: "message loud",
      deepLink: "/automations/env-1/runs/run_1",
    });
    expect(decodeRelayJwt(body.proof)).toMatchObject({
      iss: "t3-env:env-1",
      sub: "env-1",
      environmentId: "env-1",
      notification: body.notification,
    });
    const header = decodeJson(
      Buffer.from(body.proof.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { typ: string };
    expect(header.typ).toBe(RELAY_AUTOMATION_NOTIFICATION_TYP);
  }).pipe(Effect.scoped),
);
