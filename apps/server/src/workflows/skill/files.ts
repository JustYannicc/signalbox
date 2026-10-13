import { CONTROL_FLOW } from "./content/controlFlow.ts";
import { EXAMPLES } from "./content/examples.ts";
import { PATTERNS } from "./content/patterns.ts";
import { RUNS } from "./content/runs.ts";
import { SKILL } from "./content/skill.ts";
import { STEPS } from "./content/steps.ts";
import { TRIGGERS } from "./content/triggers.ts";

/**
 * The built-in `signalbox-automations` skill: the one source of truth for how
 * agents write automations. installSkill.ts puts these files in every
 * harness's skills folder; `automation_reference` serves the same text to
 * harnesses that don't load skills.
 */
export const SKILL_NAME = "signalbox-automations";

/** `automation_reference` topics and the files they serve. */
export const SKILL_TOPICS = {
  steps: STEPS,
  "control-flow": CONTROL_FLOW,
  triggers: TRIGGERS,
  runs: RUNS,
  patterns: PATTERNS,
} as const;
export type SkillTopic = keyof typeof SKILL_TOPICS;

/** Every file of the skill, by its path inside the skill folder. */
export function skillFiles(): Record<string, string> {
  return {
    "SKILL.md": SKILL,
    ...Object.fromEntries(
      Object.entries(SKILL_TOPICS).map(([topic, text]) => [`references/${topic}.md`, text]),
    ),
    ...Object.fromEntries(
      Object.entries(EXAMPLES).map(([name, text]) => [`references/examples/${name}`, text]),
    ),
  };
}

/**
 * What `automation_reference` returns: the skill's entry page without its
 * frontmatter, one topic, or one example by file name.
 */
export function skillReference(topic?: string): string | null {
  if (topic === undefined) return SKILL.replace(/^---[\s\S]*?---\n+/, "");
  if (topic in SKILL_TOPICS) return SKILL_TOPICS[topic as SkillTopic];
  const example = topic.replace(/^examples\//, "");
  return EXAMPLES[example] ?? EXAMPLES[`${example}.ts`] ?? null;
}
