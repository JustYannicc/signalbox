import { AutomationError, ProjectId } from "@t3tools/contracts";
import { nowIso } from "@signalbox/automations/time";
import { toJson } from "@signalbox/automations/json";
import type { WorkflowEngineShape } from "@signalbox/automations/WorkflowEngine";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HookOrigin } from "../automations/cloudIngress.ts";
import { HookStore } from "../automations/hookStore.ts";
import {
  MAX_HOOK_BYTES,
  verifySignature,
  type HookRequest,
  type HookAnswer,
} from "../automations/webhookRequest.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import { UserStore } from "../user/UserStore.ts";
import { GitHub } from "./GitHub.ts";
import { GitHubConnection } from "./GitHubConnection.ts";
import { GITHUB_SIGNATURE, parseGitHubPayload } from "./githubEvents.ts";
import { makeGitHubHookApi } from "./githubHookApi.ts";
import { desiredSubscriptions } from "./githubSubscriptions.ts";
import { makeGitHubWebhookStore } from "./githubWebhookStore.ts";
import { makeGitHubEventDelivery } from "./githubEventDelivery.ts";
import { pollReleases } from "./githubReleasePoll.ts";

const failure = (cause: unknown) =>
  new AutomationError({ message: "Couldn't update GitHub event subscriptions.", cause });
const decodeEvents = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const make = Effect.gen(function* () {
  const store = yield* makeGitHubWebhookStore.pipe(Effect.mapError(failure));
  const inbox = yield* HookStore;
  const connection = yield* GitHubConnection;
  const github = yield* GitHub;
  const hooks = makeGitHubHookApi(github.api);
  const users = yield* UserStore;
  const crypto = yield* Crypto.Crypto;
  const origin = yield* HookOrigin;
  const drives = yield* Effect.serviceOption(DriveDirectory);
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const deliverEvent = yield* makeGitHubEventDelivery;
  const wrap = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(failure));

  const base = Effect.gen(function* () {
    const profile = yield* users.profile;
    return profile ? `${origin}/api/github/hooks/${encodeURIComponent(profile.id)}` : null;
  });

  const reconcile = (engine: WorkflowEngineShape) =>
    wrap(
      Effect.gen(function* () {
        const automations = yield* engine.list();
        const repositories = new Map<string, string | null>();
        const profile = yield* users.profile;
        for (const projectId of new Set(automations.map((automation) => automation.projectId))) {
          const driveId = profile ? driveOfProject(ProjectId.make(projectId), profile.id) : null;
          const remote =
            driveId && drives._tag === "Some"
              ? yield* drives.value.forDrive(driveId).remote()
              : null;
          repositories.set(projectId, remote?.repository ?? null);
        }
        const desired = desiredSubscriptions(
          automations,
          (projectId) => repositories.get(projectId) ?? null,
        );
        const rows = yield* store.list;
        for (const wanted of desired) {
          const existing = rows.find(
            (row) => row.project_id === wanted.projectId && row.repository === wanted.repository,
          );
          if (!existing) {
            yield* store.insert({ id: yield* uuid, secret: yield* uuid, ...wanted });
          } else if (existing.enabled !== 1 || existing.events_json !== toJson(wanted.events)) {
            yield* store.want(existing.id, wanted.events);
          }
        }
        for (const row of rows) {
          if (
            row.enabled === 1 &&
            !desired.some(
              (wanted) =>
                wanted.projectId === row.project_id && wanted.repository === row.repository,
            )
          )
            yield* store.disable(row.id);
        }
      }),
    );

  /** The alarm retries install/removal; saving code never waits for GitHub's network. */
  const sync = wrap(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const urlBase = yield* base;
      if (urlBase === null) return;
      for (const row of yield* store.list) {
        if (row.retry_at === null ? row.hook_id !== null : row.retry_at > now) continue;
        const result = yield* Effect.gen(function* () {
          if (row.enabled !== 1 && row.hook_id === null) {
            yield* store.remove(row.id);
            return;
          }
          const token = yield* connection.accessToken;
          if (!token)
            return yield* new AutomationError({
              message: "Connect GitHub in Settings to receive repository events.",
            });
          if (row.enabled !== 1) {
            if (row.hook_id !== null) yield* hooks.remove(token, row.repository, row.hook_id);
            yield* store.remove(row.id);
            return;
          }
          const events = yield* decodeEvents(row.events_json);
          const hookId = yield* hooks.ensure(token, row.repository, {
            url: `${urlBase}/${row.id}`,
            secret: row.secret,
            events,
          });
          yield* store.ready(row.id, hookId, row.events_json);
        }).pipe(Effect.result);
        if (result._tag === "Failure") {
          const error = result.failure;
          // Public upstream releases need no repository-admin permission. The
          // same release event is read on an alarm when no hook can be installed.
          const releasesOnly = row.events_json === '["release"]';
          const denied = "status" in error && [403, 404].includes(Number(error.status));
          yield* store.failed(
            row.id,
            error instanceof Error ? error.message : "GitHub event setup failed.",
            releasesOnly && denied ? "release-poll" : denied ? "unavailable" : "webhook",
          );
          if (releasesOnly && denied && row.enabled === 1) {
            yield* Effect.gen(function* () {
              const token = yield* connection.accessToken;
              if (!token) return;
              yield* pollReleases({
                api: github.api,
                token,
                row,
                store,
                enqueue: (delivery) =>
                  inbox.enqueue({ kind: "github", target: row.id, ...delivery }),
              });
            }).pipe(
              Effect.catch(() =>
                store.failed(
                  row.id,
                  "GitHub couldn't read upstream releases; retrying.",
                  "release-poll",
                ),
              ),
            );
          }
        }
      }
    }),
  );

  const receive = Effect.fn("GitHubWebhooks.receive")(function* (
    request: HookRequest,
  ): Effect.fn.Return<HookAnswer, AutomationError> {
    if (request.body.byteLength > MAX_HOOK_BYTES) return { status: 413 };
    const row = yield* wrap(store.get(request.hookId));
    if (!row || row.enabled !== 1) return { status: 404 };
    if (!(yield* Effect.promise(() => verifySignature(GITHUB_SIGNATURE, row.secret, request))))
      return { status: 401 };
    const event = request.headers["x-github-event"];
    const deliveryId = request.headers["x-github-delivery"];
    const rawBody = new TextDecoder().decode(request.body);
    const payload = parseGitHubPayload(rawBody);
    if (
      !event ||
      !deliveryId ||
      !payload ||
      payload.repository.full_name.toLowerCase() !== row.repository
    )
      return { status: 400 };
    return yield* inbox.enqueue({
      kind: "github",
      target: row.id,
      key: deliveryId,
      payload: { event, body: rawBody, at: yield* nowIso },
    });
  });

  const status = wrap(
    store.list.pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.enabled === 1)
          .map((row) => ({
            projectId: ProjectId.make(row.project_id),
            repository: row.repository,
            mode: row.mode,
            connected: row.hook_id !== null || row.mode === "release-poll",
            error: row.error,
          })),
      ),
    ),
  );
  const deliver = (engine: WorkflowEngineShape, target: string, payload: string, id: string) =>
    wrap(
      Effect.gen(function* () {
        const row = yield* store.get(target);
        if (!row || row.enabled !== 1) return;
        yield* deliverEvent(engine, store, row, payload, id);
      }),
    );
  return { store, reconcile, sync, receive, deliver, status, nextAt: wrap(store.nextAt) };
});

export class GitHubWebhooks extends Context.Service<GitHubWebhooks, Effect.Success<typeof make>>()(
  "@signalbox/cloud/github/GitHubWebhooks",
) {}
export const layer = Layer.effect(GitHubWebhooks, make);
