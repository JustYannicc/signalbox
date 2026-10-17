import { automationOptionLabel } from "@t3tools/contracts";
import { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import * as Schema from "effect/Schema";

import { stepArgs, stepAsk } from "./columns.ts";
import { asRecord } from "./json.ts";
import type { AutomationRow, StepRow } from "./WorkflowStore.ts";

const codec = Schema.fromJsonString(SignalboxAsk);
export const decodeAsk = Schema.decodeSync(codec);
export const encodeAsk = Schema.encodeSync(codec);
export const askJsonValue = Schema.decodeUnknownSync(Schema.Json);

export function automationAskRecord(automation: AutomationRow, step: StepRow): SignalboxAsk {
  if (step.ask_json) return decodeAsk(step.ask_json);
  const { ask } = stepAsk(step);
  const options = asRecord(stepArgs(step)[0]);
  // Customizations keep the gate's registered name after clearing builtin_slug.
  const gate = automation.builtin_slug === "merge-gate" || automation.name === "Merge gate";
  const text = (key: string, fallback: string) =>
    typeof options[key] === "string" && options[key].trim() ? options[key] : fallback;
  return {
    id: `automation:${step.run_id}:${step.step_key}`,
    kind: gate ? "ready" : "blocker",
    source: { kind: "automation", runId: step.run_id, stepKey: step.step_key },
    status: "pending",
    createdAt: step.started_at,
    updatedAt: step.started_at,
    questions: [
      {
        id: step.step_key,
        question: step.label.trim() || ask.question || "Continue the automation?",
        why: text(
          "why",
          ask.question || "This automation needs your answer before it can continue.",
        ),
        unblocks: text("unblocks", `Continue ${automation.name}.`),
        recommendation:
          options.recommendation === undefined ? null : askJsonValue(options.recommendation),
        options: ask.options.map((value) => ({ label: automationOptionLabel(value), value })),
        multiSelect: ask.multi,
        blocking: true,
        decisionOwner: text("decisionOwner", "automation owner"),
        surface: { kind: "kit", component: "automation", props: { ...ask } },
      },
    ],
    rounds: [
      {
        number: 1,
        questionIds: [step.step_key],
        answers: [],
        deferredQuestionIds: [],
        openedAt: step.started_at,
        closedAt: null,
      },
    ],
  };
}
