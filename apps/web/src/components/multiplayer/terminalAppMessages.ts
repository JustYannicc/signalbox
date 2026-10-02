/** PLACEHOLDER conversations for the terminal-app team threads. */
import { CODEX, SONNET, agent, person, system } from "./fixtureAuthors";
import type { TeamMessage } from "./multiplayerModel";

export const TERMINAL_APP_MESSAGES: Readonly<Record<string, readonly TeamMessage[]>> = {
  "ta-printer-fix": [
    {
      id: "m1",
      author: person("flo"),
      body: "Receipts cut off the last line on the A920 since the firmware update.",
      at: "Yesterday",
    },
    {
      id: "m2",
      author: agent("flo", CODEX),
      at: "Yesterday",
      work: [
        {
          label: "Web search",
          itemType: "web_search",
          detail: "Neptune printer feed before cut A920",
        },
        {
          label: "Edited files",
          itemType: "file_change",
          changedFiles: ["app/src/main/java/com/northwind/printer/PrinterService.kt"],
        },
      ],
      body: "The printer now needs an explicit feed before the cut. Added `feedPaper(3)` ahead of `cutPaper()`; it still needs a check on the exact firmware.",
    },
    {
      id: "e1",
      author: system("share"),
      body: "Flynn shared this chat with Northwind team",
      at: "Yesterday",
    },
    {
      id: "m3",
      author: person("yannic"),
      body: "I have one on my desk. I'll verify on firmware 1.04 this afternoon.",
      at: "08:15",
    },
    {
      id: "m4",
      author: agent("yannic", CODEX),
      at: "08:15",
      work: [
        { label: "Edited files", itemType: "file_change", changedFiles: ["RELEASE_CHECKLIST.md"] },
      ],
      body: "Added an unchecked “A920 on firmware 1.04” gate to `RELEASE_CHECKLIST.md`, so the release can't be tagged until someone ticks it. The check: print a receipt with a long footer and confirm the last line clears the cutter.",
    },
    {
      id: "m5",
      author: person("yannic"),
      body: "@Samir should a reprinted receipt show up in the merchant timeline, or only the original?",
      at: "08:20",
    },
    { id: "e2", author: system("waiting"), body: "Codex waited for Samir", at: "08:20" },
    {
      id: "m6",
      author: person("sam"),
      body: "Only the original. Reprints would just confuse merchants.",
      at: "08:40",
    },
    {
      id: "m7",
      author: agent("sam", CODEX),
      at: "08:41",
      work: [
        { label: "Search", itemType: "command_execution", command: 'rg "ReceiptPrinted" app/src' },
      ],
      body: "Then nothing changes: only originals are logged today, and reprints stay out of the timeline.",
    },
  ],
  "ta-neptune-questions": [
    {
      id: "m1",
      author: person("yannic"),
      body: "which neptune printer calls actually need a signed build? need to know before the A920 rollout. check the javadocs",
      at: "Mon",
    },
    {
      id: "m2",
      author: agent("yannic", SONNET),
      at: "Mon",
      work: [
        {
          label: "Search",
          itemType: "command_execution",
          command: 'rg -il "signature|signed" docs/neptune-javadoc/printer',
          detail: "3 files",
        },
        {
          label: "Read",
          itemType: "command_execution",
          command: "sed -n 40,160p docs/neptune-javadoc/printer/IPrinter.html",
        },
      ],
      body: "From the Javadocs:\n\n| Call | Signed build |\n|---|---|\n| `init`, `printStr`, `step`, `start` | Not required |\n| `setGray`, `cutPaper` | Not stated |\n| `setPrinterParam` | Required (system signature) |\n\nThe gap is `cutPaper`: the printer fix calls it, and the docs don't say what firmware 1.04 enforces. Only whoever holds the signing keys can confirm that.",
    },
    {
      id: "e1",
      author: system("share"),
      body: "Yannic shared this chat with Northwind team",
      at: "Mon",
    },
    {
      id: "m3",
      author: person("yannic"),
      body: "@Flynn does cutPaper need the system signature on 1.04? the printer fix depends on it",
      at: "Mon",
    },
  ],
  "ta-offline-mode": [
    {
      id: "m1",
      author: person("sam"),
      body: "Merchants keep asking for offline card capture on the terminals. What would it take?",
      at: "Fri",
    },
    {
      id: "m2",
      author: agent("sam", CODEX),
      at: "Fri",
      work: [
        {
          label: "Web search",
          itemType: "web_search",
          detail: "store and forward card acquirer floor limit",
        },
      ],
      body: "Store-and-forward is the usual shape: queue signed transactions locally and submit when the terminal is back online. The acquirer has to allow it and sets the floor limit.",
    },
    {
      id: "m3",
      author: person("lea"),
      body: "Our partner contracts cap offline amounts, I can dig out the numbers.",
      at: "Fri",
    },
    {
      id: "m4",
      author: agent("lea", CODEX),
      at: "Fri",
      body: "The cap is the input that matters. Queue size falls out of it: at a CHF 100 offline limit and the fleet's CHF 18 average ticket, a terminal hits the limit after 5 or 6 payments. 16 slots per device covers that twice over, and the contract numbers slot into the same math.",
    },
    { id: "e1", author: system("model"), body: "Samir switched the harness to Claude", at: "Mon" },
    {
      id: "m5",
      author: person("sam"),
      body: "@Flynn does our acquirer allow store-and-forward at all? That decides whether this is worth scoping.",
      at: "Mon",
    },
    {
      id: "m6",
      author: agent("sam", SONNET),
      at: "Mon",
      work: [
        {
          label: "Search",
          itemType: "command_execution",
          command: 'rg -il "store.and.forward|offline" docs/acquirer',
          detail: "No matches",
        },
      ],
      body: "The acquirer docs in this repo never mention store-and-forward or offline capture. Flynn owns that relationship, so he's the one who can confirm.",
    },
    {
      id: "m7",
      author: person("lea"),
      body: "Can you draft the question for Flynn?",
      at: "Mon",
    },
    {
      id: "m8",
      author: agent("lea", SONNET),
      at: "Mon",
      live: "answering",
      body: "Here's a draft for Flynn:\n\n> Does our acquirer allow store-and-forward on the A920, and if so, what floor limit",
    },
  ],
};
