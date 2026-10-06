/** `references/runs.md`: Reading, retrying and drafting runs. */
export const RUNS = `# Runs

## Reading a run

\`automation_run_read\` returns the run's status, input, output, every step (status, result, error, \`errorDetail: { why, fix, link }\`, attempt, thread) and the run's console logs. Check results against what the user wanted, not only statuses.

Each agent and model step has a thread the user can open; link it when you report.

## When a run fails

1. Read the failed step's \`error\` and \`errorDetail.fix\`. Most failures say exactly what to change.
2. Fix the code, \`automation_validate\`, \`automation_save\`.
3. \`automation_run_retry\` with \`version: "latest"\` replays the failed run on the fixed code: steps that already succeeded keep their recorded results (as long as the code up to them is unchanged) and the run continues from the failure. \`version: "same"\` retries on the old code, for a failure that was outside the code (a service was down).

Cancel a run with \`automation_cancel_run\`: it stops its agent threads and \`w.run\` processes.

## Drafts

\`automation_save\` with \`draft: true\` stores a new version without changing what runs; the live version keeps handling triggers. The user sees the draft beside the live diagram with a diff. \`automation_publish\` makes it live; \`automation_discard_draft\` drops it. Save live by default; use a draft only when the user wants to review first.

## Limits worth knowing

- Steps retry transient failures (\`http\`/\`call\` 3 attempts, \`judge\`/\`extract\` 2) before failing.
- Agent steps time out after 2 hours, model steps after 10 minutes, \`w.run\` after 15 minutes; set \`timeout\` for longer.
- \`meta.timeout\` fails a run still going after that long; by default runs have no limit.
- Finished runs older than 30 days are deleted, always keeping the latest 50 per automation.
`;
