import { SignalboxLearnerSettings } from "@t3tools/contracts/signalboxLearner";
import type {
  SignalboxLearnerClassification,
  SignalboxLearnerEvent,
  SignalboxLearnerLensSummary,
  SignalboxLearnerLogEventInput,
  SignalboxLearnerLogResult,
  SignalboxLearnerMatchedLens,
  SignalboxLearnerPrecedent,
  SignalboxLearnerQueryInput,
  SignalboxLearnerQueryResult,
  SignalboxLearnerSettingsInput,
  SignalboxLearnerStatementInput,
} from "@t3tools/contracts/signalboxLearner";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as LearnerJev from "./LearnerJev.ts";
import * as LearnerStore from "./LearnerStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_PRIOR_SUPPORTS = 3;
const DRAFT_CANDIDATE_LIMIT = 10;
const PENDING_ACTION_RETRY_LIMIT = 1;

const DEFAULT_SETTINGS: SignalboxLearnerSettings = {
  minLaterSupports: 1,
  minHitRate: 0.8,
  halfLifeMs: 90 * DAY_MS,
  relevanceThreshold: 0.55,
};

const LearnerSettings = Context.Reference<SignalboxLearnerSettings>(
  "@signalbox/cloud/learner/LearnerSettings",
  { defaultValue: () => DEFAULT_SETTINGS },
);

const EventRow = Schema.Struct({
  event_id: Schema.String,
  scope: Schema.String,
  tree_id: Schema.String,
  source: Schema.String,
  kind: Schema.Literals(["observation", "draft", "human_action"]),
  content: Schema.String,
  input: Schema.NullOr(Schema.String),
  object_id: Schema.NullOr(Schema.String),
  used_lens_id: Schema.NullOr(Schema.String),
  occurred_at: Schema.Number,
});
type EventRow = typeof EventRow.Type;
const LensRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  tree_id: Schema.String,
  text: Schema.String,
  reason: Schema.String,
  condition_text: Schema.NullOr(Schema.String),
  expected_action: Schema.NullOr(Schema.String),
  seed_precedent_id: Schema.NullOr(Schema.String),
  owner_stated: Schema.Number,
  created_at: Schema.Number,
});
type LensRow = typeof LensRow.Type;
const PrecedentRow = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  input: Schema.String,
  draft: Schema.String,
  action: Schema.String,
  classification: Schema.Literals(["confirmed", "countermanded", "overridden", "ambiguous"]),
  reason: Schema.String,
  created_at: Schema.Number,
});
const EvidenceRow = Schema.Struct({
  tree_id: Schema.String,
  outcome: Schema.Literals(["support", "miss"]),
  occurred_at: Schema.Number,
});
const SettingsRow = Schema.Struct({ settings_json: Schema.String });

const decodeEvents = Schema.decodeUnknownSync(Schema.Array(EventRow));
const decodeLenses = Schema.decodeUnknownSync(Schema.Array(LensRow));
const decodePrecedents = Schema.decodeUnknownSync(Schema.Array(PrecedentRow));
const decodeEvidence = Schema.decodeUnknownSync(Schema.Array(EvidenceRow));
const decodeSettingsRows = Schema.decodeUnknownSync(Schema.Array(SettingsRow));
const SettingsJson = Schema.fromJsonString(SignalboxLearnerSettings);
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

interface LensStats {
  readonly supports: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly laterSupportCount: number;
  readonly served: boolean;
}

const statsOf = (
  lens: Pick<LensRow, "owner_stated">,
  evidence: ReadonlyArray<typeof EvidenceRow.Type>,
  now: number,
  settings: SignalboxLearnerSettings,
): LensStats => {
  let supports = lens.owner_stated ? OWNER_PRIOR_SUPPORTS : 0;
  let laterSupportCount = 0;
  let misses = 0;
  for (const item of evidence) {
    const weight = 0.5 ** (Math.max(0, now - item.occurred_at) / settings.halfLifeMs);
    if (item.outcome === "support") {
      supports += weight;
      laterSupportCount += 1;
    } else misses += weight;
  }
  const hitRate = supports + misses === 0 ? 0 : supports / (supports + misses);
  return {
    supports,
    misses,
    hitRate,
    laterSupportCount,
    served:
      hitRate >= settings.minHitRate &&
      (lens.owner_stated === 1 || laterSupportCount >= settings.minLaterSupports),
  };
};

const toPrecedent = (row: typeof PrecedentRow.Type): SignalboxLearnerPrecedent => ({
  id: row.id,
  source: row.source,
  input: row.input,
  draft: row.draft,
  action: row.action,
  classification: row.classification,
  reason: row.reason,
  matchReason: "Jev judged this task relevant to the precedent.",
  createdAt: row.created_at,
});

const reasonOf = (classification: SignalboxLearnerClassification) => {
  switch (classification) {
    case "confirmed":
      return "The person's action confirmed the agent draft.";
    case "countermanded":
      return "The person's action changed the agent draft.";
    case "overridden":
      return "The person's action replaced the agent draft.";
    case "ambiguous":
      return "The paired events do not establish a clear decision.";
  }
};

export class LearnerSettingsError extends Schema.TaggedError<LearnerSettingsError>()(
  "LearnerSettingsError",
  {
    field: Schema.Literals(["minLaterSupports", "minHitRate", "halfLifeMs", "relevanceThreshold"]),
  },
) {
  override get message() {
    return "The learner settings are outside their supported range.";
  }
}

export class LearnerTreeRevokedError extends Schema.TaggedError<LearnerTreeRevokedError>()(
  "LearnerTreeRevokedError",
  {},
) {
  override get message() {
    return "This membership no longer permits learning.";
  }
}

export class LearnerService extends Context.Service<
  LearnerService,
  {
    readonly logEvent: (
      input: SignalboxLearnerLogEventInput,
    ) => Effect.Effect<SignalboxLearnerLogResult, SqlError | LearnerTreeRevokedError>;
    readonly addStatement: (
      input: SignalboxLearnerStatementInput,
    ) => Effect.Effect<SignalboxLearnerLensSummary, SqlError | LearnerTreeRevokedError>;
    readonly query: (
      input: SignalboxLearnerQueryInput,
    ) => Effect.Effect<SignalboxLearnerQueryResult, SqlError>;
    /** Cross-level projection; omits ids, reasons, precedents, and source events. */
    readonly lenses: (input: {
      readonly scope: string;
      readonly task?: string | undefined;
    }) => Effect.Effect<{ readonly lenses: ReadonlyArray<SignalboxLearnerLensSummary> }, SqlError>;
    readonly setSettings: (
      input: SignalboxLearnerSettingsInput,
    ) => Effect.Effect<void, SqlError | LearnerSettingsError | LearnerTreeRevokedError>;
    readonly revokeTree: (treeId: string) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/learner/LearnerService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const jev = yield* LearnerJev.LearnerJev;

  const [ensureTables] = yield* Effect.cachedInvalidateWithTTL(
    LearnerStore.createTables(sql),
    (exit) => (exit._tag === "Success" ? "Infinity" : 0),
  );
  const evidenceFor = (lensId: string) =>
    Effect.map(
      sql`SELECT tree_id, outcome, occurred_at FROM sbx_level_learner_668_evidence
        WHERE lens_id = ${lensId} ORDER BY occurred_at`,
      decodeEvidence,
    );
  const statsFor = (lens: LensRow, now: number, settings: SignalboxLearnerSettings) =>
    Effect.map(evidenceFor(lens.id), (evidence) => statsOf(lens, evidence, now, settings));
  const allLenses = (scope: string) =>
    Effect.map(
      sql`SELECT id, scope, tree_id, text, reason, condition_text, expected_action,
          seed_precedent_id, owner_stated, created_at
        FROM sbx_level_learner_668_lenses WHERE scope = ${scope} ORDER BY created_at, id`,
      decodeLenses,
    );
  const lensById = (scope: string, id: string) =>
    Effect.map(
      sql`SELECT id, scope, tree_id, text, reason, condition_text, expected_action,
          seed_precedent_id, owner_stated, created_at
        FROM sbx_level_learner_668_lenses WHERE scope = ${scope} AND id = ${id}`,
      (rows) => decodeLenses(rows)[0],
    );
  const lensSummary = (lens: LensRow, now: number, settings: SignalboxLearnerSettings) =>
    Effect.map(statsFor(lens, now, settings), (stats): SignalboxLearnerLensSummary => ({
      text: lens.text,
      ownerStated: lens.owner_stated === 1,
      supports: stats.supports,
      misses: stats.misses,
      hitRate: stats.hitRate,
    }));

  const storedEvent = (eventId: string) =>
    Effect.map(
      sql`SELECT event_id, scope, tree_id, source, kind, content, input, object_id,
          used_lens_id, occurred_at
        FROM sbx_level_learner_668_events WHERE event_id = ${eventId}`,
      (rows) => decodeEvents(rows)[0] ?? null,
    );
  const saveEvent = (scope: string, event: SignalboxLearnerEvent, now: number) =>
    Effect.gen(function* () {
      const wrote = yield* sql`INSERT INTO sbx_level_learner_668_events
        (event_id, scope, tree_id, source, kind, content, input, object_id, used_lens_id, occurred_at)
        SELECT ${event.eventId}, ${scope}, ${event.treeId}, ${event.source}, ${event.kind},
          ${event.content}, ${event.input ?? null}, ${event.objectId ?? null},
          ${event.usedLensId ?? null}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM sbx_level_learner_668_revoked_trees WHERE tree_id = ${event.treeId})
        ON CONFLICT(event_id) DO NOTHING
        RETURNING event_id`;
      const stored = yield* storedEvent(event.eventId);
      if (stored === null && wrote.length === 0) return yield* new LearnerTreeRevokedError();
      return { event: stored, inserted: wrote.length > 0 };
    });

  const precedentIdFor = (draftId: string, actionId: string) =>
    `precedent:${encodeURIComponent(draftId)}:${encodeURIComponent(actionId)}`;

  const inputForDraft = (scope: string, draft: EventRow, action: EventRow) =>
    Effect.gen(function* () {
      if (draft.input !== null) return draft.input;
      if (action.input !== null) return action.input;
      if (draft.object_id === null) return "";
      const rows = decodeEvents(
        yield* sql`SELECT event_id, scope, tree_id, source, kind, content, input, object_id,
            used_lens_id, occurred_at
          FROM sbx_level_learner_668_events
          WHERE scope = ${scope} AND tree_id = ${draft.tree_id}
            AND kind = 'observation' AND object_id = ${draft.object_id}
          ORDER BY occurred_at DESC LIMIT 1`,
      );
      return rows[0]?.content ?? "";
    });

  const draftCandidates = (scope: string, treeId: string, objectId: string | null) =>
    Effect.map(
      sql`SELECT e.event_id, e.scope, e.tree_id, e.source, e.kind, e.content, e.input,
          e.object_id, e.used_lens_id, e.occurred_at
        FROM sbx_level_learner_668_events e
        WHERE e.scope = ${scope} AND e.tree_id = ${treeId} AND e.kind = 'draft'
          AND (e.object_id = ${objectId} OR e.object_id IS NULL OR ${objectId} IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM sbx_level_learner_668_precedents p
            WHERE p.draft_event_id = e.event_id
          )
        ORDER BY e.occurred_at DESC LIMIT ${DRAFT_CANDIDATE_LIMIT}`,
      decodeEvents,
    );

  const processAction = (scope: string, action: EventRow) =>
    Effect.gen(function* () {
      const already = yield* sql`SELECT id FROM sbx_level_learner_668_precedents
        WHERE action_event_id = ${action.event_id} LIMIT 1`;
      if (already.length > 0) return null;

      let draft: EventRow | undefined;
      if (action.object_id !== null) {
        const exact = decodeEvents(
          yield* sql`SELECT event_id, scope, tree_id, source, kind, content, input,
              object_id, used_lens_id, occurred_at
            FROM sbx_level_learner_668_events
            WHERE scope = ${scope} AND tree_id = ${action.tree_id}
              AND kind = 'draft' AND object_id = ${action.object_id}
              AND NOT EXISTS (
                SELECT 1 FROM sbx_level_learner_668_precedents p
                WHERE p.draft_event_id = sbx_level_learner_668_events.event_id
              )
            ORDER BY occurred_at DESC LIMIT 1`,
        );
        draft = exact[0];
      }
      if (draft === undefined) {
        const candidates = yield* draftCandidates(scope, action.tree_id, action.object_id);
        const match = yield* jev.matchDraft({
          action: action.content,
          candidates: yield* Effect.forEach(candidates, (candidate) =>
            Effect.map(inputForDraft(scope, candidate, action), (input) => ({
              eventId: candidate.event_id,
              input,
              draft: candidate.content,
            })),
          ),
        });
        if (Option.isNone(match)) return null;
        draft = candidates.find((candidate) => candidate.event_id === match.value.eventId);
      }
      if (draft === undefined) return null;

      const input = yield* inputForDraft(scope, draft, action);
      const classified = yield* jev.classifyPair({
        input,
        draft: draft.content,
        action: action.content,
      });
      if (Option.isNone(classified)) return null;

      const id = precedentIdFor(draft.event_id, action.event_id);
      const reason = reasonOf(classified.value);
      const existingLenses = yield* allLenses(scope);
      const askedLensId = draft.used_lens_id;
      const directUsedLens = askedLensId === null ? undefined : yield* lensById(scope, askedLensId);
      const scored = yield* Effect.forEach(
        existingLenses,
        (lens) =>
          Effect.gen(function* () {
            if (directUsedLens?.id === lens.id) {
              const outcome =
                classified.value === "confirmed"
                  ? "support"
                  : classified.value === "ambiguous"
                    ? null
                    : "miss";
              return outcome === null ? null : { lens, outcome };
            }
            const outcome = yield* jev.outcome({
              precedent: { input, draft: draft.content, action: action.content },
              lens: { id: lens.id, text: lens.text, reason: lens.reason },
            });
            return Option.isNone(outcome) ? null : { lens, outcome: outcome.value };
          }),
        { concurrency: 4 },
      );
      const supportedExistingLens = scored.some((score) => score?.outcome === "support");

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // A membership revocation can remove the inputs while Jev is running.
          const present = yield* sql`SELECT event_id FROM sbx_level_learner_668_events
            WHERE scope = ${scope} AND event_id IN (${draft.event_id}, ${action.event_id})`;
          if (present.length !== 2) return null;
          const claimed = yield* sql`SELECT id FROM sbx_level_learner_668_precedents
            WHERE draft_event_id = ${draft.event_id} OR action_event_id = ${action.event_id}
            LIMIT 1`;
          if (claimed.length > 0) return null;
          yield* sql`INSERT INTO sbx_level_learner_668_precedents
            (id, scope, tree_id, draft_tree_id, action_tree_id, draft_event_id, action_event_id,
              source, input, draft, action, classification, reason, created_at)
            VALUES (${id}, ${scope}, ${action.tree_id}, ${draft.tree_id}, ${action.tree_id},
              ${draft.event_id}, ${action.event_id}, ${`${draft.source} → ${action.source}`},
              ${input}, ${draft.content}, ${action.content}, ${classified.value}, ${reason},
              ${action.occurred_at}) ON CONFLICT(draft_event_id, action_event_id) DO NOTHING`;
          for (const score of scored) {
            if (score === null) continue;
            // Old decisions may match a rule, but cannot become later validation when retried.
            yield* sql`INSERT INTO sbx_level_learner_668_evidence
              (lens_id, precedent_id, tree_id, outcome, occurred_at)
              SELECT ${score.lens.id}, ${id}, ${action.tree_id}, ${score.outcome}, ${action.occurred_at}
              WHERE ${score.lens.owner_stated} = 1 OR EXISTS (
                SELECT 1 FROM sbx_level_learner_668_precedents seed
                JOIN sbx_level_learner_668_events seed_action
                  ON seed_action.event_id = seed.action_event_id
                JOIN sbx_level_learner_668_events current_action
                  ON current_action.event_id = ${action.event_id}
                WHERE seed.id = ${score.lens.seed_precedent_id}
                  AND current_action.rowid > seed_action.rowid
              )
              ON CONFLICT(lens_id, precedent_id) DO NOTHING`;
          }
          if (
            !supportedExistingLens &&
            classified.value !== "ambiguous" &&
            input.trim() !== "" &&
            action.content.trim() !== ""
          ) {
            const lensId = `lens:${encodeURIComponent(id)}`;
            const text = `When the task is like: ${input.trim()} Choose: ${action.content.trim()}`;
            yield* sql`INSERT INTO sbx_level_learner_668_lenses
              (id, scope, tree_id, text, reason, condition_text, expected_action,
                seed_precedent_id, owner_stated, created_at)
              VALUES (${lensId}, ${scope}, ${action.tree_id}, ${text}, ${reason}, ${input},
                ${action.content}, ${id}, 0, ${action.occurred_at}) ON CONFLICT(id) DO NOTHING`;
          }
          return id;
        }),
      );
    });

  const pendingAction = (scope: string, now: number, preferredDraft?: EventRow) =>
    Effect.map(
      sql`SELECT e.event_id, e.scope, e.tree_id, e.source, e.kind, e.content, e.input,
          e.object_id, e.used_lens_id, e.occurred_at
        FROM sbx_level_learner_668_events e
        LEFT JOIN sbx_level_learner_668_action_retries r ON r.action_event_id = e.event_id
        WHERE e.scope = ${scope} AND e.kind = 'human_action'
          AND NOT EXISTS (
            SELECT 1 FROM sbx_level_learner_668_precedents p
            WHERE p.action_event_id = e.event_id
          )
          AND (${preferredDraft === undefined ? 0 : 1} = 0 OR (
            e.tree_id = ${preferredDraft?.tree_id ?? ""}
            AND (e.object_id = ${preferredDraft?.object_id ?? null}
              OR e.object_id IS NULL OR ${preferredDraft?.object_id ?? null} IS NULL)
          ))
          AND (r.action_event_id IS NULL OR r.next_attempt_at <= ${now}
            OR ${preferredDraft === undefined ? 0 : 1})
        ORDER BY
          CASE WHEN ${preferredDraft === undefined ? 0 : 1} = 1
              AND ${preferredDraft?.object_id ?? null} IS NOT NULL
              AND e.object_id = ${preferredDraft?.object_id ?? null} THEN 0
            WHEN ${preferredDraft === undefined ? 0 : 1} = 1 AND e.object_id IS NULL THEN 1
            ELSE 2 END,
          CASE WHEN r.attempted_at IS NULL THEN 0 ELSE 1 END,
          r.attempted_at ASC, e.occurred_at ASC, e.event_id ASC
        LIMIT ${PENDING_ACTION_RETRY_LIMIT}`,
      (rows) => decodeEvents(rows)[0] ?? null,
    );

  const attemptAction = (scope: string, action: EventRow, now: number) =>
    Effect.gen(function* () {
      const id = yield* processAction(scope, action);
      if (id !== null) {
        yield* LearnerStore.clearActionRetry(sql, action.event_id);
        return id;
      }
      const [paired] = yield* sql`SELECT id FROM sbx_level_learner_668_precedents
        WHERE action_event_id = ${action.event_id} LIMIT 1`;
      if (paired !== undefined || (yield* storedEvent(action.event_id)) === null) {
        yield* LearnerStore.clearActionRetry(sql, action.event_id);
      } else {
        yield* LearnerStore.recordActionRetry(sql, action.event_id, now);
      }
      return null;
    });

  const retryPending = (scope: string, now: number, preferredDraft?: EventRow) =>
    Effect.gen(function* () {
      const action = yield* pendingAction(scope, now, preferredDraft);
      if (action === null) return [];
      const id = yield* attemptAction(scope, action, now);
      return id === null ? [] : [id];
    });

  const readSettings = (scope: string) =>
    Effect.gen(function* () {
      const rows = decodeSettingsRows(
        yield* sql`SELECT settings_json FROM sbx_level_learner_668_settings WHERE scope = ${scope}`,
      );
      if (rows[0] === undefined) return yield* LearnerSettings;
      return yield* decodeSettings(rows[0].settings_json).pipe(Effect.catch(() => LearnerSettings));
    });

  const presentLens = (
    lens: LensRow,
    now: number,
    settings: SignalboxLearnerSettings,
    probability: number,
  ) =>
    Effect.map(statsFor(lens, now, settings), (stats): SignalboxLearnerMatchedLens => ({
      id: lens.id,
      text: lens.text,
      reason: lens.reason,
      matchReason: `Jev judged this task relevant (${probability.toFixed(2)}).`,
      ownerStated: lens.owner_stated === 1,
      served: stats.served,
      supports: stats.supports,
      misses: stats.misses,
      hitRate: stats.hitRate,
    }));

  const logEvent: LearnerService["Service"]["logEvent"] = (input) =>
    Effect.gen(function* () {
      yield* ensureTables;
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* saveEvent(input.scope, input.event, now);
      const existing = saved.event;
      if (existing === null || existing.scope !== input.scope) {
        return { eventId: input.event.eventId, stored: false, paired: false };
      }
      // Action replays retry immediately; other pending actions use a fair,
      // persisted backoff, and a new draft wakes actions that could use it.
      if (existing.kind === "human_action") {
        yield* attemptAction(input.scope, existing, now);
      }
      if (existing.kind === "draft") yield* retryPending(input.scope, now, existing);
      if (existing.kind === "human_action") {
        const [precedent] = decodePrecedents(
          yield* sql`SELECT id, source, input, draft, action, classification, reason, created_at
            FROM sbx_level_learner_668_precedents WHERE action_event_id = ${existing.event_id}`,
        );
        return precedent === undefined
          ? { eventId: existing.event_id, stored: saved.inserted, paired: false }
          : {
              eventId: existing.event_id,
              stored: saved.inserted,
              paired: true,
              precedentId: precedent.id,
            };
      }
      const pairedDraft = yield* sql`SELECT id FROM sbx_level_learner_668_precedents
        WHERE draft_event_id = ${existing.event_id} LIMIT 1`;
      return {
        eventId: existing.event_id,
        stored: saved.inserted,
        paired: pairedDraft.length > 0,
      };
    });

  const addStatement: LearnerService["Service"]["addStatement"] = (input) =>
    Effect.gen(function* () {
      yield* ensureTables;
      const now = yield* Clock.currentTimeMillis;
      const id = `statement:${encodeURIComponent(input.scope)}:${encodeURIComponent(input.treeId)}:${encodeURIComponent(input.text)}`;
      yield* sql`INSERT INTO sbx_level_learner_668_lenses
        (id, scope, tree_id, text, reason, condition_text, expected_action,
          seed_precedent_id, owner_stated, created_at)
        SELECT ${id}, ${input.scope}, ${input.treeId}, ${input.text}, ${input.reason},
          NULL, NULL, NULL, 1, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM sbx_level_learner_668_revoked_trees WHERE tree_id = ${input.treeId})
        ON CONFLICT(scope, tree_id, text)
          WHERE owner_stated = 1 DO NOTHING`;
      const lens = yield* lensById(input.scope, id);
      if (lens === undefined) {
        return yield* new LearnerTreeRevokedError();
      }
      return yield* lensSummary(lens, now, yield* readSettings(input.scope));
    });

  const query: LearnerService["Service"]["query"] = (input) =>
    Effect.gen(function* () {
      yield* ensureTables;
      const now = yield* Clock.currentTimeMillis;
      yield* retryPending(input.scope, now);
      const settings = yield* readSettings(input.scope);
      const rawPrecedents = decodePrecedents(
        yield* sql`SELECT id, source, input, draft, action, classification, reason, created_at
          FROM sbx_level_learner_668_precedents
          WHERE scope = ${input.scope} ORDER BY created_at DESC LIMIT 32`,
      );
      const candidates = yield* allLenses(input.scope);
      const lensMatches = yield* jev.relevance({
        task: input.task,
        candidates: candidates.map((lens) => ({
          id: lens.id,
          text: lens.text,
          reason: lens.reason,
        })),
      });
      const matchedLenses = yield* Effect.forEach(
        lensMatches.filter((match) => match.probability >= settings.relevanceThreshold),
        (match) => {
          const lens = candidates.find((candidate) => candidate.id === match.lensId);
          return lens === undefined
            ? Effect.succeed(null)
            : presentLens(lens, now, settings, match.probability);
        },
      );
      const precedentMatches = yield* jev.relevance({
        task: input.task,
        candidates: rawPrecedents.map((row) => ({
          id: row.id,
          text: `Task: ${row.input}\nAgent draft: ${row.draft}\nPerson's action: ${row.action}`,
          reason: reasonOf(row.classification),
        })),
      });
      const precedents = precedentMatches
        .filter((match) => match.probability >= settings.relevanceThreshold)
        .sort((a, b) => b.probability - a.probability)
        .flatMap((match) => {
          const row = rawPrecedents.find((candidate) => candidate.id === match.lensId);
          return row === undefined ? [] : [toPrecedent(row)];
        });
      const lenses = matchedLenses
        .filter((lens): lens is SignalboxLearnerMatchedLens => lens !== null)
        .sort((a, b) => b.supports - a.supports);
      const candidate = lenses.find((lens) => lens.served);
      const coverage =
        candidate === undefined
          ? Option.none()
          : yield* jev.coverage({
              task: input.task,
              lens: candidate,
              otherLenses: lenses.filter((lens) => lens.id !== candidate.id),
              precedents: precedents.map((precedent) => ({
                input: precedent.input,
                draft: precedent.draft,
                action: precedent.action,
              })),
            });
      const answerLens =
        Option.isSome(coverage) && coverage.value === "clear" ? candidate : undefined;
      return {
        precedents,
        lenses,
        answerAlone: answerLens !== undefined,
        usedLensId: answerLens?.id ?? null,
      };
    });

  const lenses: LearnerService["Service"]["lenses"] = (input) =>
    Effect.gen(function* () {
      yield* ensureTables;
      const now = yield* Clock.currentTimeMillis;
      const settings = yield* readSettings(input.scope);
      const all = yield* allLenses(input.scope);
      let visible = all;
      if (input.task !== undefined) {
        const relevance = yield* jev.relevance({
          task: input.task,
          candidates: all.map((lens) => ({ id: lens.id, text: lens.text, reason: lens.reason })),
        });
        const relevant = new Set(
          relevance
            .filter((match) => match.probability >= settings.relevanceThreshold)
            .map((match) => match.lensId),
        );
        visible = all.filter((lens) => relevant.has(lens.id));
      }
      const served = yield* Effect.filter(visible, (lens) =>
        Effect.map(statsFor(lens, now, settings), (stats) => stats.served),
      );
      return { lenses: yield* Effect.forEach(served, (lens) => lensSummary(lens, now, settings)) };
    });

  const setSettings: LearnerService["Service"]["setSettings"] = (input) =>
    Effect.gen(function* () {
      yield* ensureTables;
      const { minLaterSupports, minHitRate, halfLifeMs, relevanceThreshold } = input.settings;
      if (!Number.isFinite(minLaterSupports) || minLaterSupports < 0) {
        return yield* new LearnerSettingsError({ field: "minLaterSupports" });
      }
      if (!Number.isFinite(minHitRate) || minHitRate < 0 || minHitRate > 1) {
        return yield* new LearnerSettingsError({ field: "minHitRate" });
      }
      if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
        return yield* new LearnerSettingsError({ field: "halfLifeMs" });
      }
      if (
        !Number.isFinite(relevanceThreshold) ||
        relevanceThreshold < 0 ||
        relevanceThreshold > 1
      ) {
        return yield* new LearnerSettingsError({ field: "relevanceThreshold" });
      }
      const settings = yield* encodeSettings(input.settings).pipe(Effect.orDie);
      const wrote =
        yield* sql`INSERT INTO sbx_level_learner_668_settings (scope, tree_id, settings_json)
        SELECT ${input.scope}, ${input.treeId}, ${settings}
        WHERE NOT EXISTS (SELECT 1 FROM sbx_level_learner_668_revoked_trees WHERE tree_id = ${input.treeId})
        ON CONFLICT(scope) DO UPDATE SET tree_id = excluded.tree_id,
          settings_json = excluded.settings_json RETURNING scope`;
      if (wrote.length === 0) return yield* new LearnerTreeRevokedError();
      return;
    });

  const revokeTree: LearnerService["Service"]["revokeTree"] = (treeId) =>
    LearnerStore.deleteTreeContributions(sql, treeId);

  return LearnerService.of({
    logEvent: (input) => logEvent(input).pipe(Effect.withSpan("Learner.logEvent")),
    addStatement: (input) => addStatement(input).pipe(Effect.withSpan("Learner.addStatement")),
    query: (input) => query(input).pipe(Effect.withSpan("Learner.query")),
    lenses: (input) => lenses(input).pipe(Effect.withSpan("Learner.lenses")),
    setSettings: (input) => setSettings(input).pipe(Effect.withSpan("Learner.setSettings")),
    revokeTree: (treeId) => revokeTree(treeId).pipe(Effect.withSpan("Learner.revokeTree")),
  });
});

/** One provider-independent service over the caller's SQLite database. */
export const layer = Layer.effect(LearnerService, make);
