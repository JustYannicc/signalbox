/** Appended to the shared orchestration instructions, so every provider learns about automations. */
export const AUTOMATION_INSTRUCTIONS = `

### Automations

When work should happen without anyone supervising it (on a schedule, on a webhook or an app event such as a turn finishing, or as a multi-step process that coordinates agents, approvals, APIs or code), write an automation instead of supervising it yourself turn by turn: one TypeScript file whose diagram Signalbox draws from the code. Before writing or changing one, read the \`signalbox-automations\` skill, or call \`automation_reference\` if your harness doesn't load skills, and follow its loop: \`automation_validate\` until it's clean, \`automation_save\` (live unless the user wants to review a draft), then \`automation_run\` and check every step with \`automation_run_read\`. Prefer an automation over \`schedule_task\` whenever the work is more than one prompt on a schedule.
`;
