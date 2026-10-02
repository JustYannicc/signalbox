/**
 * PLACEHOLDER conversations for the loose Home items (`LOOSE_ITEMS` in
 * `sidebar/sections/sectionModel.ts`). Each ends the way its sidebar status
 * says: a finished answer, a question back (input), or a proposed plan.
 */
import { CODEX, SONNET, agent, person } from "./fixtureAuthors";
import type { TeamMessage } from "./multiplayerModel";

export const LOOSE_ITEM_MESSAGES: Readonly<Record<string, readonly TeamMessage[]>> = {
  "chat-okr-draft": [
    {
      id: "m1",
      author: person("yannic"),
      body: "draft q4 okrs for the team. terminal rollout, refund reliability, fewer support tickets. max 3 objectives",
      at: "08:40",
    },
    {
      id: "m2",
      author: agent("yannic", CODEX),
      at: "08:42",
      work: [
        { label: "Google Drive", itemType: "mcp_tool_call", detail: "Read “Q3 OKR review”" },
        {
          label: "Jira",
          itemType: "mcp_tool_call",
          detail: "project = TERM AND created >= -90d · 212 issues",
        },
      ],
      body: "Draft, using the Q3 review for baselines:\n\n**O1. Firmware 3.3 on every terminal without a bad morning**\n- 1.1 All pilot terminals on 3.3 by 12 Oct\n- 1.2 Full fleet by 30 Nov\n- 1.3 Zero rollbacks after 09:00\n\n**O2. Refunds reach merchants the first time**\n- 2.1 Webhook first-attempt success from 91% to 99%\n- 2.2 No double-posted refunds\n\n**O3. Fewer tickets per terminal**\n- 3.1 Tickets per 100 terminals from 7.4 to 5\n- 3.2 Pairing guide linked in every “won't pair” reply\n\nThe 91% and 7.4 baselines are from the Q3 review. 2.1 assumes the retry fix ships in October.",
    },
    {
      id: "m3",
      author: person("yannic"),
      body: "1.3 is weird. make it something we can actually measure",
      at: "08:51",
    },
    {
      id: "m4",
      author: agent("yannic", CODEX),
      at: "08:51",
      body: "1.3 is now: **Contactless read success stays at or above 98.5% in the week after each wave.** The terminal health dashboard already tracks that rate, so nobody has to count by hand.",
    },
  ],
  "task-expense-report": [
    {
      id: "m1",
      author: person("yannic"),
      body: "submit my september expense report. receipts are in gmail, card statement is in drive",
      at: "09:05",
    },
    {
      id: "m2",
      author: agent("yannic", CODEX),
      at: "09:09",
      work: [
        {
          label: "Google Drive",
          itemType: "mcp_tool_call",
          detail: "Read “Card statement 2026-09.pdf” · 14 charges",
        },
        {
          label: "Gmail",
          itemType: "mcp_tool_call",
          detail: "receipt OR invoice after:2026/09/01 before:2026/10/01 · 12 threads",
        },
        {
          label: "Edited files",
          itemType: "file_change",
          changedFiles: ["expenses/2026-09.csv"],
        },
      ],
      body: "12 of 14 charges are matched and in `expenses/2026-09.csv` (CHF 1,284.60). Not submitted yet, two charges have no receipt:\n\n| Date | Merchant | Amount |\n|---|---|---|\n| 09.09 | Train ticket | CHF 88.00 |\n| 17.09 | Restaurant | CHF 142.50 |\n\nWas the 17.09 dinner with a client? The policy needs attendee names for that. Train tickets usually sit in the rail app, not email; a screenshot works.",
    },
  ],
  "chat-terminal-rollout": [
    {
      id: "m1",
      author: person("yannic"),
      body: "which terminals get the 3.3 rollout first? pull it from the pilot sheet",
      at: "Fri",
    },
    {
      id: "m2",
      author: agent("yannic", SONNET),
      at: "Fri",
      work: [
        {
          label: "Google Sheets",
          itemType: "mcp_tool_call",
          detail: "Read “Firmware pilot list” · 48 rows",
        },
        {
          label: "Jira",
          itemType: "mcp_tool_call",
          detail: "fixVersion = 3.3 AND status != Done · 3 issues",
        },
      ],
      body: "Wave 1 is the 12 rows marked `wave 1`, all A920s already on firmware 1.04:\n\n| Group | Terminals | Why first |\n|---|---|---|\n| Downtown retail pilot | 6 | Staff on site before opening |\n| Hospitality group | 4 | Low evening volume |\n| Internal test fleet | 2 | Ours to break |\n\nThe A77s stay out of wave 1 because of the open card-timeout bug.",
    },
    { id: "m3", author: person("yannic"), body: "what's the A77 bug exactly", at: "Fri" },
    {
      id: "m4",
      author: agent("yannic", SONNET),
      at: "Fri",
      work: [{ label: "Jira", itemType: "mcp_tool_call", detail: "Read TERM-412" }],
      body: "TERM-412: on 3.3, contactless reads time out after the terminal resumes from sleep. Same resume path that broke 3.2. The fix is in review, not merged, so the A77s move to wave 2.",
    },
  ],
  "chat-lisbon": [
    {
      id: "m1",
      author: person("yannic"),
      body: "ideas for a 3 day offsite in lisbon, 8 people, mid october. not too touristy pls",
      at: "Sun",
    },
    {
      id: "m2",
      author: agent("yannic", SONNET),
      at: "Sun",
      work: [
        {
          label: "Web search",
          itemType: "web_search",
          detail: "Lisbon meeting space 8 people Marvila",
        },
        {
          label: "Web search",
          itemType: "web_search",
          detail: "Arrábida day trip October weather boat",
        },
      ],
      body: "A shape that keeps you out of the Baixa crowds:\n\n1. **Day 1, Marvila.** Rent a warehouse studio for the working sessions, dinner at one of the converted-factory places nearby.\n2. **Day 2, Arrábida.** Train to Setúbal, boat along the coast, back by 18:00. Mid-October is usually still 20–23 °C.\n3. **Day 3, Alfama in the morning.** Walk it before 10:00, then the afternoon off before flights.\n\nFor 8 people, two apartments next to each other beat a hotel on price and give you a place to sit together in the evening.",
    },
  ],
  "task-tax-return": [
    {
      id: "m1",
      author: person("yannic"),
      body: "file the tax return. everything should be in the taxes folder in drive",
      at: "Mon",
    },
    {
      id: "m2",
      author: agent("yannic", CODEX),
      at: "Mon",
      work: [
        { label: "Google Drive", itemType: "mcp_tool_call", detail: "List Taxes · 17 files" },
        {
          label: "Google Drive",
          itemType: "mcp_tool_call",
          detail: "Read the income and deduction documents",
        },
      ],
      body: "Everything's there except one deduction receipt. It's the only missing piece. Nothing is filed until you approve the plan.",
      plan: "## File the tax return\n\n1. Fill in income and deductions from the documents in Drive.\n2. Add the missing receipt once it's in Drive.\n3. Show you the draft summary before anything is sent.\n4. Submit online only after you confirm.",
    },
  ],
  "chat-schema-question": [
    {
      id: "m1",
      author: person("yannic"),
      body: "how does Schema.fromJsonString decode? parse then validate, or both at once?",
      at: "Wed",
    },
    {
      id: "m2",
      author: agent("yannic", CODEX),
      at: "Wed",
      work: [
        {
          label: "Search",
          itemType: "command_execution",
          command: 'rg -n "function fromJsonString" .repos/effect-smol/packages/effect/src',
        },
        {
          label: "Read",
          itemType: "command_execution",
          command: "sed -n 9168,9210p .repos/effect-smol/packages/effect/src/Schema.ts",
        },
      ],
      body: "Parse, then validate. It's `JsonString.pipe(decodeTo(schema, …))`: decoding runs `JSON.parse` on the string first, then decodes the parsed value with your schema. Encoding goes the other way: your schema encodes, then `JSON.stringify`.\n\n```ts\nconst Payload = Schema.fromJsonString(Schema.Struct({ id: Schema.Number }))\nSchema.decodeUnknownSync(Payload)('{\"id\":1}') // { id: 1 }\n```\n\nSo a malformed string fails before your schema runs, and the error says which of the two steps broke.",
    },
  ],
};
