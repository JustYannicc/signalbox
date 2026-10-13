import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow } from "../compiler/compileWorkflow.ts";
import { EXAMPLES } from "./content/examples.ts";
import { skillFiles, skillReference, SKILL_TOPICS } from "./files.ts";
import { skillsAddArgs } from "./installSkill.ts";

describe("the automations skill", () => {
  it.each(Object.keys(EXAMPLES))("compiles the example %s", (name) => {
    const result = compileWorkflow(EXAMPLES[name]!);
    expect(result.ok ? [] : result.diagnostics).toEqual([]);
  });

  it("compiles every TypeScript block in its pages", () => {
    const pages = Object.entries(skillFiles()).filter(([path]) => path.endsWith(".md"));
    for (const [path, text] of pages) {
      for (const [, code] of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
        if (!code!.includes("export default workflow")) continue;
        const result = compileWorkflow(code!);
        expect(result.ok ? [] : result.diagnostics, path).toEqual([]);
      }
    }
  });

  it("is a valid skill whose references all exist", () => {
    const files = skillFiles();
    const skill = files["SKILL.md"]!;
    expect(skill).toMatch(/^---\nname: signalbox-automations\ndescription: Use when .+\n---\n/);
    for (const [, path] of skill.matchAll(/`(references\/[\w./-]+)`/g)) {
      const prefix = path!.endsWith("/") ? path! : null;
      expect(
        prefix ? Object.keys(files).some((file) => file.startsWith(prefix)) : path! in files,
        path,
      ).toBe(true);
    }
  });

  it("serves the same text through automation_reference", () => {
    expect(skillReference()).toContain("## The loop");
    expect(skillReference()).not.toContain("name: signalbox-automations");
    for (const [topic, text] of Object.entries(SKILL_TOPICS))
      expect(skillReference(topic)).toBe(text);
    expect(skillReference("work-through-tickets")).toBe(EXAMPLES["work-through-tickets.ts"]);
    expect(skillReference("nope")).toBeNull();
  });

  it("installs globally for every harness Signalbox runs, without prompts", () => {
    const args = skillsAddArgs("/state/skills/signalbox-automations");
    expect(args.slice(0, 3)).toEqual(["add", "/state/skills/signalbox-automations", "--global"]);
    for (const agent of ["claude-code", "codex", "cursor", "opencode", "grok", "antigravity"]) {
      expect(args).toContain(agent);
    }
    expect(args).toEqual(expect.arrayContaining(["--yes", "--copy"]));
  });
});
