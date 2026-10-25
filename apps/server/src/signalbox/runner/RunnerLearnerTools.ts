import {
  LEARNER_TOOL_NAMES,
  LearnerAddStatementInput,
  LearnerLogEventInput,
  LearnerLensesInput,
  LearnerQueryInput,
} from "@signalbox/runner-protocol/LearnerProtocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ContextClient } from "./RunnerContextClient.ts";
import { fail, register, ToolError } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

/** The cloud resolves the thread's learner and enforces folder ancestry. */
const DECLARATIONS = {
  learner_log_event: {
    description:
      "Record an observation, an agent draft, or a person's action for this learner. eventId is local to this thread; reuse it only when retrying the same source event. Pair a draft and a later action with the same objectId. objectId identifies a shared decision across threads in this level, so include the source and decision ID rather than a generic label.",
    parameters: LearnerLogEventInput,
    readonly: false,
  },
  learner_query: {
    description:
      "Ask this level's learner for precedents and learned lenses relevant to a task, including whether the evidence is sufficient to answer on this level's behalf.",
    parameters: LearnerQueryInput,
    readonly: true,
  },
  learner_add_statement: {
    description:
      "Record a rule the owner has stated directly. Include why it applies; the learner gives owner statements a stronger prior.",
    parameters: LearnerAddStatementInput,
    readonly: false,
  },
  learner_lenses: {
    description:
      "Read summaries of learned lenses. The current level is used by default; a folderId may name only a descendant folder. Summaries contain no event or precedent content.",
    parameters: LearnerLensesInput,
    readonly: true,
  },
} as const;

/** Every tool the context server exposes for learners. */
export const RUNNER_LEARNER_TOOLS: ReadonlyArray<string> = LEARNER_TOOL_NAMES;

const answer = (result: unknown) => (result === undefined ? "" : JSON.stringify(result));

type Input = Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never };

const client = (view: DrivesView) =>
  Effect.suspend((): Effect.Effect<ContextClient, ToolError> => {
    const current = view.client();
    return current === null
      ? fail("Learner tools open with the thread's first turn.")
      : Effect.succeed(current);
  });

const call = (view: DrivesView, name: (typeof LEARNER_TOOL_NAMES)[number], input: unknown) =>
  Effect.gen(function* () {
    const result = yield* (yield* client(view))
      .learnerTool(
        { name, input },
        {
          retry: DECLARATIONS[name].readonly,
        },
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new ToolError({
              message:
                error.status === undefined
                  ? "The learner's cloud didn't answer, so this may not have happened. Check before retrying."
                  : error.message,
            }),
        ),
      );
    if (result._tag === "failed") return yield* fail(result.message);
    return result.result;
  });

const mcp = <S extends Input>(
  name: string,
  declaration: { description: string; parameters: S; readonly: boolean },
) => ({
  name,
  description: declaration.description,
  parameters: declaration.parameters,
  ...(declaration.readonly ? {} : { writes: { destructive: false, openWorld: false } }),
});

/** Learner tools use the thread's own drive token; callers never select a person or learner scope. */
export const layerLearnerTools = (view: DrivesView) =>
  Layer.effectDiscard(
    Effect.all([
      register({
        ...mcp("learner_log_event", DECLARATIONS.learner_log_event),
        handle: (input) => call(view, "learner_log_event", input).pipe(Effect.map(answer)),
      }),
      register({
        ...mcp("learner_query", DECLARATIONS.learner_query),
        handle: (input) => call(view, "learner_query", input).pipe(Effect.map(answer)),
      }),
      register({
        ...mcp("learner_add_statement", DECLARATIONS.learner_add_statement),
        handle: (input) => call(view, "learner_add_statement", input).pipe(Effect.map(answer)),
      }),
      register({
        ...mcp("learner_lenses", DECLARATIONS.learner_lenses),
        handle: (input) => call(view, "learner_lenses", input).pipe(Effect.map(answer)),
      }),
    ]),
  );
