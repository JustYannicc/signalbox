/**
 * PLACEHOLDER conversations for team threads, shaped like real AI chats: each
 * person's message gets the agent's turn right away (work, then the answer),
 * unless the thread waits for everyone. System lines record model and harness
 * switches, shares and kind changes, the way a group chat logs a new title.
 */
import { CODEX, SONNET, agent, person, system } from "./fixtureAuthors";
import { LOOSE_ITEM_MESSAGES } from "./looseItemMessages";
import type { TeamMessage } from "./multiplayerModel";
import { TERMINAL_APP_MESSAGES } from "./terminalAppMessages";

export const TEAM_MESSAGES: Readonly<Record<string, readonly TeamMessage[]>> = {
  ...TERMINAL_APP_MESSAGES,
  ...LOOSE_ITEM_MESSAGES,
  "mp-refund-webhooks": [
    {
      id: "m1",
      author: person("yannic"),
      body: "Refund webhooks give up after the first 5xx. Can we retry with backoff and keep them idempotent?",
      at: "09:12",
    },
    {
      id: "m2",
      author: agent("yannic", CODEX),
      at: "09:14",
      work: [
        { label: "Search", itemType: "command_execution", command: 'rg "RefundNotifier" src' },
        {
          label: "Read",
          itemType: "command_execution",
          command: "sed -n 1,120p src/refunds/RefundNotifier.ts",
        },
      ],
      body: "Found it: `RefundNotifier` swallows the error after one attempt. I'd move delivery onto the existing job queue and key it on the refund id.",
      plan: "## Retry refund webhooks\n\n1. Move delivery onto `JobQueue` with 5 retries (1m, 5m, 30m, 2h, 12h).\n2. Key each job on the refund id so a retry never double-posts.\n3. Surface the final failure on the refund.",
    },
    {
      id: "e1",
      author: system("model"),
      body: "Flynn switched the model to Claude Sonnet 4.5",
      at: "09:30",
    },
    {
      id: "m3",
      author: person("flo"),
      body: "Merchants on the old integration dedupe on the event id, not the refund id. Keep the event id stable across retries or we'll double-post.",
      at: "09:31",
    },
    {
      id: "m4",
      author: agent("flo", SONNET),
      at: "09:36",
      work: [
        {
          label: "Edited files",
          itemType: "file_change",
          changedFiles: ["src/refunds/RefundNotifier.ts", "src/refunds/refundJobs.ts"],
        },
        { label: "Run tests", itemType: "command_execution", command: "pnpm test refunds" },
      ],
      body: "The event id is now minted once and reused on every retry. Added a test for the double-post case.",
    },
    {
      id: "m5",
      author: person("sam"),
      body: "+1. Also log each attempt so support can see it in the merchant timeline.",
      at: "09:40",
    },
    {
      id: "m6",
      author: agent("sam", SONNET),
      at: "09:44",
      work: [
        {
          label: "Edited files",
          itemType: "file_change",
          changedFiles: ["src/merchantTimeline/timelineEntries.ts"],
        },
        {
          label: "Run tests",
          itemType: "command_execution",
          command: "pnpm test refunds timeline",
        },
      ],
      body: "Each attempt now writes a merchant timeline entry with the attempt number and status code.",
    },
    {
      id: "m7",
      author: person("yannic"),
      body: "@Flynn does the old integration treat a 409 as delivered? I don't know that path and don't want retries hammering it.",
      at: "10:05",
    },
    {
      id: "m8",
      author: agent("yannic", SONNET),
      at: "10:06",
      work: [{ label: "Search", itemType: "command_execution", command: 'rg "409" src/refunds' }],
      body: "Nothing in this repo handles 409 specially; the old integration lives outside it. Flynn owns that side.",
    },
    {
      id: "m9",
      author: person("flo"),
      body: "Yes, 409 means they already have it. Treat it as success and stop retrying.",
      at: "10:11",
    },
    {
      id: "m10",
      author: agent("flo", SONNET),
      at: "10:13",
      work: [
        {
          label: "Edited files",
          itemType: "file_change",
          changedFiles: ["src/refunds/RefundNotifier.ts"],
        },
        { label: "Run tests", itemType: "command_execution", command: "pnpm test refunds" },
      ],
      body: "A 409 now counts as delivered and ends the retries.",
    },
    {
      id: "m11",
      author: person("yannic"),
      body: "Looks right. Push the branch once the tests pass.",
      at: "10:20",
    },
    {
      id: "m12",
      author: agent("yannic", SONNET),
      at: "10:21",
      live: "working",
      work: [
        {
          label: "Edited files",
          itemType: "file_change",
          changedFiles: ["src/refunds/RefundNotifier.test.ts"],
        },
        {
          label: "Run tests",
          itemType: "command_execution",
          command: "pnpm test refunds",
          running: true,
        },
      ],
      approval: { kind: "command", detail: "git push origin refund-webhook-retries" },
      body: "",
    },
  ],
  "mp-payout-copy": [
    { id: "e1", author: system("kind"), body: "Samir made this a task", at: "Yesterday" },
    {
      id: "m1",
      author: person("sam"),
      body: "The payout dashboard says 'Settlement pending' for three different states. Can we split them?",
      at: "Yesterday",
    },
    {
      id: "m2",
      author: agent("sam", CODEX),
      at: "Yesterday",
      work: [
        { label: "Search", itemType: "command_execution", command: 'rg "Settlement pending" src' },
      ],
      body: "Three states share that label: queued, in review, and waiting for the bank. Proposed copy below.",
      plan: "## Payout status copy\n\n- Queued → **Scheduled**\n- In review → **In review**\n- Waiting for the bank → **Waiting for bank**",
    },
    {
      id: "m3",
      author: person("yannic"),
      body: "I like 'Waiting for bank'. @Samir is 'In review' clear enough for merchants?",
      at: "10:22",
    },
  ],
  "mp-settlement-pagination": [
    {
      id: "m1",
      author: person("yannic"),
      body: "Cursor or offset pagination for the settlements list? Some merchants have 40k rows.",
      at: "Mon",
    },
    {
      id: "m2",
      author: agent("yannic", SONNET),
      at: "Mon",
      work: [
        { label: "Search", itemType: "command_execution", command: 'rg -l "settlements" src' },
      ],
      body: "Cursor. Offsets get slow and skip rows while new settlements land. Key the cursor on `(booked_at, id)` so ties stay stable.",
    },
    {
      id: "m3",
      author: person("yannic"),
      body: "Would the CSV export use the same cursor?",
      at: "11:02",
    },
    {
      id: "m4",
      author: agent("yannic", SONNET),
      at: "11:02",
      live: "thinking",
      reasoning:
        "The export streams every row, so it may not page at all. Checking whether it reuses the list query or has its own…",
      body: "",
    },
  ],
};
