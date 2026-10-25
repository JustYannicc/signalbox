import * as NodeAssert from "node:assert/strict";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { CommandId, MessageId, ProjectId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createLocalClaudeThreadHost } from "../../../LocalClaudeThreadHost.ts";
import { localDomainHostInputs } from "./continuationHost.ts";

const modelRequest = Schema.fromJsonString(
  Schema.Struct({ model: Schema.String, messages: Schema.Array(Schema.Unknown) }),
);

export const run = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* localDomainHostInputs;
        const modelRequests: string[] = [];
        const binding = yield* createLocalClaudeThreadHost({
          modelSelection: input.sessionInput.modelSelection,
          modelTransport: async (request) => {
            const body = Schema.decodeUnknownSync(modelRequest)(await request.clone().text());
            NodeAssert.equal(body.model, input.sessionInput.modelSelection.model);
            NodeAssert.ok(body.messages.length > 0);
            const url = new URL(request.url);
            modelRequests.push(`${url.pathname}${url.search}`);
            return input.hostOptions.modelTransport(request);
          },
          machine: {
            databases: {
              user: NodeSqliteClient.layer({ filename: ":memory:" }),
              pool: NodeSqliteClient.layer({ filename: ":memory:" }),
              thread: NodeSqliteClient.layer({ filename: ":memory:" }),
            },
            host: input.hostOptions,
            open: (work) => {
              NodeAssert.ok(work.turn);
              return {
                session: {
                  ...input.sessionInput,
                  modelSelection: work.turn.modelSelection,
                  providerSessionId:
                    work.turn.providerThread.providerSessionId ??
                    input.sessionInput.providerSessionId,
                },
                bootAttemptId: "local-domain-turn",
              };
            },
            access: (work) =>
              Effect.sync(() => {
                NodeAssert.ok(work.turn);
                input.setRunId(work.turn.runId);
                return input.access;
              }),
          },
        });
        const owner = yield* binding.actor;
        NodeAssert.deepEqual(binding.modelSelection.options, [{ id: "effort", value: "xhigh" }]);
        NodeAssert.equal(owner.userId, binding.owner.id);
        NodeAssert.deepEqual(
          yield* binding.domain.directory.forUser(owner.userId).profile(),
          binding.owner,
        );
        NodeAssert.deepEqual(owner.contextIds, [PERSONAL_CONTEXT_ID]);
        NodeAssert.deepEqual(yield* binding.domain.directory.forUser(owner.userId).contextIds(), [
          PERSONAL_CONTEXT_ID,
        ]);
        NodeAssert.equal(
          yield* binding.domain.directory.forUser(owner.userId).onePasswordToken(),
          null,
        );
        NodeAssert.ok(
          (yield* binding.domain.directory.forUser(owner.userId).readableDrives()).drives.length >
            0,
        );
        const models = yield* binding.pool.models({ userId: owner.userId });
        NodeAssert.deepEqual(
          models.models.map((model) => model.id),
          [binding.modelSelection.model],
        );
        yield* Effect.flip(binding.pool.models({ userId: "unrelated-local-user" }));
        const catalog = yield* binding.domain.catalog;
        NodeAssert.ok(
          catalog.providers.some((provider) =>
            provider.models.some((model) => model.slug === binding.modelSelection.model),
          ),
        );
        NodeAssert.ok(catalog.providers.some((provider) => provider.status === "ready"));
        const launch = {
          commandId: CommandId.make("local-domain-launch"),
          threadId: input.threadId,
          projectId: ProjectId.make("scratch"),
          title: "A real local thread",
          modelSelection: binding.modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          workspaceStrategy: { type: "root" as const },
          initialMessage: {
            messageId: MessageId.make("local-domain-initial-message"),
            text: "Run the controlled commands.",
            attachments: [],
          },
        };
        const rejected = yield* Effect.flip(
          binding.launch({
            ...launch,
            commandId: CommandId.make("local-domain-unserved-model"),
            modelSelection: { ...binding.modelSelection, model: "unregistered-model" },
          }),
        );
        NodeAssert.match(String(rejected), /doesn't serve|not.*serv/i);
        NodeAssert.deepEqual(modelRequests, []);
        yield* binding.launch(launch);
        yield* binding.subscribe().pipe(
          Stream.flattenIterable,
          Stream.takeUntil(
            (item) =>
              (item.kind === "snapshot" &&
                item.projection.runs.some((run) => run.status === "completed")) ||
              (item.kind === "event" &&
                item.event.type === "run.updated" &&
                item.event.payload.status === "completed"),
          ),
          Stream.runDrain,
          Effect.raceFirst(binding.failure),
        );
        const snapshot = yield* binding.snapshot();
        NodeAssert.equal(snapshot.projection.runs.length, 1);
        NodeAssert.equal(snapshot.projection.runs[0]?.status, "completed");
        yield* Effect.flip(
          binding.threads.snapshot({ ...owner, userId: "unrelated-local-user" }, input.threadId),
        );
        NodeAssert.deepEqual(modelRequests, [
          "/v1/messages?fixture=root",
          "/v1/messages?fixture=child",
        ]);
        NodeAssert.equal(input.native.queryIdentities.length, 1);
        NodeAssert.equal(input.native.userPromptCount, 1);
        NodeAssert.deepEqual(input.native.querySelections, [
          { model: "claude-opus-5-5", effort: "xhigh" },
        ]);
        yield* binding.dispose;
      }),
    ),
  );
