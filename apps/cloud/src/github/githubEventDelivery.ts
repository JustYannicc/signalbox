import { AutomationError, type AutomationEventName } from "@t3tools/contracts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { GitHub } from "./GitHub.ts";
import { PullRequestMerges, type MergeEvidence } from "./PullRequestMerges.ts";
import { gitHubSignals, parseGitHubPayload } from "./githubEvents.ts";
import type { GitHubWebhookStore, SubscriptionRow } from "./githubWebhookStore.ts";

const Delivery = Schema.Struct({
  event: Schema.String,
  body: Schema.String,
  at: Schema.optional(Schema.String),
});
const Remark = Schema.Struct({
  id: Schema.Number,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  path: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.String),
});
const decodeRemark = Schema.decodeUnknownOption(Remark);

/** The delivered remark remains available even when GitHub retries it days later. */
export const deliveredRemarks = (event: string, raw: unknown) => {
  const decoded = decodeRemark(raw);
  if (Option.isNone(decoded)) return null;
  const remark = decoded.value;
  return [
    {
      id: String(remark.id),
      kind: event === "pr.reviewed" ? "review" : remark.path ? "thread" : "issue",
      author: remark.user?.login ?? null,
      body: remark.body?.slice(0, 4_000) ?? null,
      path: remark.path ?? null,
      reviewState: remark.state ?? null,
      url: remark.html_url ?? null,
      at: remark.updated_at ?? remark.submitted_at ?? remark.created_at ?? null,
    },
  ];
};
const decodeDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(Delivery));

/** Same aggregate states as upstream's check rollup, with null for unread checks. */
export const checksStateOf = (checks: MergeEvidence["checks"]) =>
  checks === null || checks.length === 0
    ? null
    : checks.some((check) => check.status === "failure" || check.status === "cancelled")
      ? "failing"
      : checks.some((check) => check.status === "pending" || check.status === "action-required")
        ? "pending"
        : "passing";

/** A durable delivery is acknowledged only once every triggered run and waiting step has taken it. */
export const makeGitHubEventDelivery = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const merges = yield* PullRequestMerges;
  const github = yield* GitHub;
  return (store: GitHubWebhookStore, row: SubscriptionRow, encoded: string, id: string) =>
    Effect.gen(function* () {
      const delivery = decodeDelivery(encoded);
      const payload = parseGitHubPayload(delivery.body);
      if (!payload) return;
      const at = delivery.at ?? DateTime.formatIso(yield* DateTime.now);
      const repository = row.repository;
      const emit = (
        event: AutomationEventName,
        fields: Readonly<Record<string, unknown>>,
        number: number | null,
      ) =>
        engine.deliverEvent({
          event,
          id: `github:${id}:${number ?? "repository"}:${event}`,
          at,
          projectId: row.project_id,
          fields: Effect.succeed({ repository, ...fields }),
        });
      for (const signal of gitHubSignals(delivery.event, payload)) {
        if (signal.number === null) {
          for (const event of signal.events) yield* emit(event, signal.fields, null);
          continue;
        }
        const number = signal.number;
        const facts = yield* merges.evidence({ repository, number }).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: "Couldn't read the delivered pull request's facts.",
                cause,
              }),
          ),
        );
        if (signal.headSha !== undefined && facts.headSha !== signal.headSha) continue;
        const checksState = checksStateOf(facts.checks);
        const before = yield* store.previous(row.id, number).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: "Couldn't read previous pull request facts.",
                cause,
              }),
          ),
        );
        const events = new Set(signal.events);
        const checksCompleted = signal.events.includes("pr.checks.completed");
        if (
          checksCompleted &&
          (facts.headSha !== before?.head_sha || checksState !== before?.checks_state)
        ) {
          if (checksState === "passing") events.add("pr.checks.passed");
          if (checksState === "failing") events.add("pr.checks.failed");
        }
        if (facts.mergeability === "conflicting" && before?.mergeability !== "conflicting")
          events.add("pr.conflicted");
        const remarks = signal.events.includes("pr.reviewed")
          ? deliveredRemarks("pr.reviewed", payload.review)
          : signal.events.includes("pr.commented")
            ? deliveredRemarks("pr.commented", payload.comment)
            : null;
        const fields = {
          repository,
          number,
          url: `https://${github.api.host}/${repository}/pull/${number}`,
          ...facts,
          checksState,
          action: payload.action ?? null,
          ...signal.fields,
          remarks,
          failedChecks:
            facts.checks?.filter((check) =>
              ["failure", "cancelled", "action-required"].includes(check.status),
            ) ?? null,
        };
        for (const event of events) yield* emit(event, fields, number);
        yield* store
          .facts(row.id, number, {
            headSha: facts.headSha,
            // PR updates can arrive after checks finish; only check deliveries advance this cursor.
            checksState: checksCompleted
              ? checksState
              : before !== undefined && facts.headSha === before.head_sha
                ? before.checks_state
                : null,
            mergeability: facts.mergeability,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AutomationError({ message: "Couldn't keep the delivered PR facts.", cause }),
            ),
          );
      }
    });
});
