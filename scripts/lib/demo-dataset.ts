/**
 * Fabricated projects and threads for the fork's demo environment
 * (`scripts/demo-environment.ts`). Pure data: the seeder owns git, files, and
 * SQLite. Names mirror the Home sidebar prototype's placeholders (Work ›
 * Northwind team, Personal); Northwind repos live under a `northwind/` directory so the
 * sidebar's "contains northwind" placement heuristic files them under Work.
 */

export type DemoProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export const DEMO_MODEL_BY_PROVIDER: Record<DemoProvider, string> = {
  codex: "gpt-6-astra",
  claudeAgent: "claude-fable-5-1",
  cursor: "composer-2",
  grok: "grok-build",
  opencode: "openai/gpt-5",
};

export interface DemoRemote {
  readonly host: "github.com" | "gitlab.com";
  readonly repository: string;
}

export interface DemoProject {
  readonly id: string;
  readonly title: string;
  /** Relative to the demo home's `demo-repos/`. */
  readonly directory: string;
  readonly group: "northwind" | "personal";
  readonly emoji: string;
  /** Null for a local-only repo (no remote, no pull requests). */
  readonly remote: DemoRemote | null;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * - running: session running (the server orphans this on boot; re-apply with
 *   `--mark-running` once the dev server is up)
 * - approval / input: a pending approval or question the sidebar surfaces
 * - plan: plan mode with an actionable proposed plan
 * - failed: latest turn errored and the session carries the error
 * - interrupted: the user stopped the latest turn
 * - done: latest turn completed
 */
export type DemoThreadState =
  | "running"
  | "approval"
  | "input"
  | "plan"
  | "failed"
  | "interrupted"
  | "done";

/**
 * A work-log row. Strings keep the terse form ("Ran …", "Edited …",
 * "Read …"); objects carry command output or an exit code.
 */
export type DemoTool =
  | string
  | {
      readonly command: string;
      readonly output?: string;
      readonly exitCode?: number;
    };

/**
 * A native subagent. Claude agents settle as completed/failed; Codex children
 * settle as idle (resumable) or failed, like the real adapters report them.
 */
export interface DemoSubagent {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly model: string;
  readonly effort?: string;
  readonly status: "running" | "completed" | "idle" | "failed";
  /** Minutes from spawn to settle; running agents ignore it. */
  readonly minutes: number;
  /** Latest progress line (live) or the idle child's last summary. */
  readonly progress?: string;
  readonly lastTool?: string;
  readonly result?: string;
  readonly error?: string;
  readonly tokens: number;
  readonly toolUses?: number;
  /** Workflow phase index; only for members of `thread.workflow`. */
  readonly phase?: number;
}

export interface DemoWorkflow {
  readonly id: string;
  readonly name: string;
  readonly phases: ReadonlyArray<string>;
  readonly summary: string;
}

/** A todo list snapshot (`turn.plan.updated`), e.g. Codex update_plan or Claude TodoWrite. */
export type DemoTodo = readonly [string, "pending" | "inProgress" | "completed"];

export interface DemoCompaction {
  /** Exchange index whose turn started with the compaction. */
  readonly turn: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
}

export interface DemoPullRequest {
  readonly number: number;
  readonly state: "open" | "merged" | "closed";
  readonly isDraft?: boolean;
  readonly checks: "passing" | "failing" | "pending";
  readonly review: "approved" | "changes-requested" | "review-required" | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

export interface DemoThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: DemoProvider;
  readonly state: DemoThreadState;
  /** Minutes since the latest activity. */
  readonly minutesAgo: number;
  readonly branch?: string;
  /** Check the branch out as a git worktree under the demo home. */
  readonly worktree?: boolean;
  readonly pinKey?: string;
  readonly settled?: boolean;
  readonly snoozeHours?: number;
  readonly archived?: boolean;
  readonly pullRequest?: DemoPullRequest;
  /**
   * [user, assistant, tools?] per turn. Only the latest answer may be null:
   * still running, or cut off by an error or interrupt. The optional third
   * entry is that turn's work log; `tools` below belongs to the latest turn.
   */
  readonly exchanges: ReadonlyArray<
    readonly [string, string | null] | readonly [string, string | null, ReadonlyArray<DemoTool>]
  >;
  readonly tools?: ReadonlyArray<DemoTool>;
  /** Minutes the agent worked on each turn before answering. Default 3. */
  readonly workMinutes?: number;
  readonly approval?: string;
  readonly approvalKind?: "command" | "file-change";
  readonly question?: {
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<string>;
  };
  readonly plan?: string;
  /** Latest turn's reasoning; streams while the thread is running. */
  readonly reasoning?: string;
  readonly todos?: ReadonlyArray<DemoTodo>;
  readonly subagents?: ReadonlyArray<DemoSubagent>;
  readonly workflow?: DemoWorkflow;
  /** Runtime error that ended the latest turn (state "failed"). */
  readonly error?: string;
  /** Context window at the end of the latest turn; derived when omitted. */
  readonly context?: { readonly usedTokens: number; readonly maxTokens: number };
  readonly compaction?: DemoCompaction;
  /**
   * Files each completed turn wrote, by exchange index. The seeder turns them
   * into real checkpoint refs so the Diff panel has turn and thread diffs.
   */
  readonly checkpoints?: ReadonlyArray<Readonly<Record<string, string>>>;
}

/** Context window size the demo reports per provider. */
export const DEMO_CONTEXT_WINDOW_BY_PROVIDER: Record<DemoProvider, number> = {
  codex: 272_000,
  claudeAgent: 200_000,
  cursor: 200_000,
  grok: 256_000,
  opencode: 272_000,
};

const pkg = (name: string) =>
  `${JSON.stringify({ name, private: true, type: "module", scripts: { dev: "vite", test: "vitest" } }, null, 2)}\n`;

export const DEMO_PROJECTS: ReadonlyArray<DemoProject> = [
  {
    id: "demo-t3code",
    title: "t3code",
    directory: "personal/t3code",
    group: "personal",
    emoji: "⚡",
    remote: { host: "github.com", repository: "yannic-demo/t3code" },
    files: {
      "package.json": pkg("t3code"),
      "README.md": "# t3code\n\nPersonal fork of T3 Code.\n",
      "apps/web/src/sidebar/HomeSidebar.tsx":
        "export function HomeSidebar() {\n  return null;\n}\n",
      "apps/web/src/composer/sendLock.ts": "export const sendLock = { locked: false };\n",
    },
  },
  {
    id: "demo-merchant-portal",
    title: "merchant-portal",
    directory: "northwind/merchant-portal",
    group: "northwind",
    emoji: "💳",
    remote: { host: "gitlab.com", repository: "northwind-demo/merchant-portal" },
    files: {
      "package.json": pkg("merchant-portal"),
      "README.md":
        "# Merchant Portal\n\nMerchant-facing dashboard for payments, refunds, and payouts.\n",
      "src/webhooks/refunds.ts":
        "export async function deliverRefundWebhook(id: string) {\n  return fetch(`/hooks/${id}`);\n}\n",
      "src/pages/AccountPools.tsx": "export function AccountPools() {\n  return null;\n}\n",
    },
  },
  {
    id: "demo-terminal-app",
    title: "terminal-app",
    directory: "northwind/terminal-app",
    group: "northwind",
    emoji: "🧾",
    remote: { host: "gitlab.com", repository: "northwind-demo/terminal-app" },
    files: {
      "build.gradle.kts": 'plugins { id("com.android.application") }\n',
      "README.md": "# Terminal App\n\nPayDroid terminal app for PAX A920 and A77.\n",
      "app/src/main/java/com/northwind/terminal/Printer.kt":
        "class Printer {\n  fun print(receipt: String) {}\n}\n",
    },
  },
  {
    id: "demo-northwind-docs",
    title: "northwind-docs",
    directory: "northwind/northwind-docs",
    group: "northwind",
    emoji: "📚",
    remote: { host: "gitlab.com", repository: "northwind-demo/northwind-docs" },
    files: {
      "README.md": "# northwind docs\n\nPublic developer documentation.\n",
      "docs/terminal/onboarding.md": "# Terminal onboarding\n\nTODO\n",
      "docs/webhooks.md": "# Webhooks\n\nWebhooks notify you about state changes.\n",
    },
  },
  {
    id: "demo-appa-vm",
    title: "appa-vm",
    directory: "personal/appa-vm",
    group: "personal",
    emoji: "🦬",
    remote: { host: "github.com", repository: "yannic-demo/appa-vm" },
    files: {
      "README.md": "# appa-vm\n\nHome lab VM definitions.\n",
      "cloud-init/user-data.yaml": "#cloud-config\npackages:\n  - git\n",
      "flake.nix": "{ outputs = { self }: { }; }\n",
    },
  },
  {
    id: "demo-dotfiles",
    title: "dotfiles",
    directory: "personal/dotfiles",
    group: "personal",
    emoji: "🛠️",
    remote: { host: "github.com", repository: "yannic-demo/dotfiles" },
    files: {
      "README.md": "# dotfiles\n",
      ".zshrc": "export EDITOR=nvim\nalias g=git\n",
      "ghostty/config": "theme = dark\n",
    },
  },
  {
    id: "demo-notes",
    title: "notes",
    directory: "personal/notes",
    group: "personal",
    emoji: "📝",
    remote: null,
    files: {
      "someday.md": "# Someday\n\n- Learn to make fresh pasta\n- Try skydiving\n",
      "recipes.md": "# Recipes\n\n- Lentil chili\n- Overnight oats\n",
    },
  },
];

const H = 60;
const D = 24 * H;

export const DEMO_THREADS: ReadonlyArray<DemoThread> = [
  // ── t3code ────────────────────────────────────────────────────────────
  {
    id: "demo-home-sidebar",
    projectId: "demo-t3code",
    title: "Ship Home sidebar sections",
    provider: "codex",
    state: "running",
    minutesAgo: 5,
    branch: "feat/home-sidebar-sections",
    worktree: true,
    pinKey: "g",
    pullRequest: {
      number: 412,
      state: "open",
      isDraft: true,
      checks: "pending",
      review: null,
      additions: 684,
      deletions: 121,
      changedFiles: 14,
    },
    exchanges: [
      [
        "Split the Home sidebar into Work › Northwind team and Personal sections. Projects should land by name, and I want drag to override it.",
        "Sections are in. Placement uses the project name and root, overrides persist per project, and the tree keeps its expansion state across reloads.",
      ],
      ["Now add the Chat/Task chip on each row and keep it one line tall.", null],
    ],
    tools: [
      "Read apps/web/src/sidebar/HomeSidebarTree.tsx",
      {
        command: 'rg -n "ThreadKind" apps/web/src/sidebar',
        output:
          'apps/web/src/sidebar/sections/threadKind.ts:4:export type ThreadKind = "chat" | "task";\napps/web/src/sidebar/HomeSidebarRow.tsx:12:import type { ThreadKind } from "./sections/threadKind";',
      },
      "Edited apps/web/src/sidebar/sections/sectionModel.ts",
    ],
    todos: [
      ["Add the kind chip to HomeSidebarRow", "completed"],
      ["Keep rows one line in compact density", "inProgress"],
      ["Cover the chat → task switch in tests", "pending"],
    ],
    subagents: [
      {
        id: "0199b1e4-2c7a-7d10-8f3e-5a6c1d9e0b21",
        title: "row_chip",
        role: "worker",
        model: "gpt-6-luna",
        effort: "high",
        status: "running",
        minutes: 0,
        progress: "Measuring row height with the chip in compact density",
        lastTool: "exec_command",
        tokens: 48_210,
      },
      {
        id: "0199b1e4-2c7b-7a42-b5d0-1e7f3a8c6d44",
        title: "chip_tests",
        role: "explorer",
        model: "gpt-6-luna",
        effort: "medium",
        status: "idle",
        minutes: 2,
        progress:
          "4 row tests snapshot the row height; only HomeSidebarRow.test.tsx needs a chip case.",
        tokens: 21_930,
      },
    ],
  },
  {
    id: "demo-composer-lock",
    projectId: "demo-t3code",
    title: "Fix composer send lock race",
    provider: "claudeAgent",
    state: "approval",
    minutesAgo: 9,
    branch: "fix/composer-send-lock",
    worktree: true,
    exchanges: [
      [
        "Double-pressing Enter sometimes sends the message twice. Find the race and fix it.",
        "The lock is released before the dispatch receipt lands. I moved the release into the receipt handler and added a regression test. I need to run the web test suite to confirm.",
      ],
    ],
    tools: [
      {
        command: 'rg -n "sendLock" apps/web/src',
        output:
          "apps/web/src/composer/sendLock.ts:1:export const sendLock = { locked: false };\napps/web/src/composer/Composer.tsx:88:    sendLock.locked = false;",
      },
      "Read apps/web/src/composer/sendLock.ts",
      "Edited apps/web/src/composer/sendLock.ts",
      "Created apps/web/src/composer/sendLock.test.ts",
    ],
    approval: "vp test run apps/web/src/composer/sendLock.test.ts",
    checkpoints: [
      {
        "apps/web/src/composer/sendLock.ts": `/**
 * One send at a time per composer. The lock is held until the server's
 * dispatch receipt lands, not until the request resolves locally.
 */
export const sendLock = {
  locked: false,
  pendingCommandId: null as string | null,
};

export function acquireSendLock(commandId: string): boolean {
  if (sendLock.locked) return false;
  sendLock.locked = true;
  sendLock.pendingCommandId = commandId;
  return true;
}

export function releaseOnReceipt(commandId: string): void {
  if (sendLock.pendingCommandId !== commandId) return;
  sendLock.locked = false;
  sendLock.pendingCommandId = null;
}
`,
        "apps/web/src/composer/sendLock.test.ts": `import { expect, it } from "vitest";

import { acquireSendLock, releaseOnReceipt, sendLock } from "./sendLock";

it("ignores a second Enter until the first send's receipt lands", () => {
  expect(acquireSendLock("cmd-1")).toBe(true);
  expect(acquireSendLock("cmd-2")).toBe(false);
  releaseOnReceipt("cmd-1");
  expect(sendLock.locked).toBe(false);
});

it("keeps the lock when a stale receipt arrives", () => {
  expect(acquireSendLock("cmd-3")).toBe(true);
  releaseOnReceipt("cmd-1");
  expect(sendLock.locked).toBe(true);
  releaseOnReceipt("cmd-3");
});
`,
      },
    ],
  },
  {
    id: "demo-offline-mode",
    projectId: "demo-t3code",
    title: "Brainstorm offline mode",
    provider: "grok",
    state: "done",
    minutesAgo: 3 * H,
    exchanges: [
      [
        "Brainstorm what an offline mode for the mobile app could look like.",
        "Three options, cheapest first:\n\n1. **Read-only cache**: keep the last shell snapshot and thread bodies, grey out the composer.\n2. **Queued sends**: store drafts with a local id, replay on reconnect, dedupe by command id.\n3. **Local environment**: run a tiny server on-device. Probably not worth it.\n\nOption 2 gets you most of the value.",
      ],
      [
        "What breaks with queued sends?",
        "Ordering across devices. If you queue on the phone while the desktop sends, the replay lands after newer turns. Showing queued messages as pending until the server accepts them keeps that honest.",
      ],
    ],
    tools: [
      "Read apps/mobile/src/state/shellSnapshot.ts",
      'Ran rg -n "reconnect" packages/client-runtime/src',
    ],
  },
  {
    id: "demo-pipeline-grouping",
    projectId: "demo-t3code",
    title: "Should the pipeline view group by PR?",
    provider: "claudeAgent",
    state: "input",
    minutesAgo: 25,
    exchanges: [
      [
        "Should the pipeline view group threads by pull request or by branch?",
        "Grouping by PR matches how you review, but threads without PRs need a home. Before I sketch it, one question.",
      ],
    ],
    tools: [
      "Read apps/web/src/pipeline/PipelineView.tsx",
      'Ran rg -l "pullRequest" apps/web/src/pipeline',
    ],
    question: {
      header: "Grouping",
      question: "Where should threads without a pull request go?",
      options: ["Bottom bucket", "Group by branch", "Hide them"],
    },
  },
  {
    id: "demo-thread-kind",
    projectId: "demo-t3code",
    title: "Refactor thread kind heuristic",
    provider: "codex",
    state: "plan",
    minutesAgo: 48,
    exchanges: [
      [
        "Plan how to move the Chat/Task heuristic behind a classifier so Jev can replace it later.",
        "Here's the plan. Nothing is edited yet.",
      ],
    ],
    tools: ['Ran rg -n "kindFromTitle" apps/web/src', "Read threadKind.ts"],
    plan: "# Move thread kind behind a classifier\n\n1. Extract `kindFromTitle` into `classifyThread` with a narrow input.\n2. Keep user overrides in the local store; they always win.\n3. Add a `ThreadKindSource` seam so a Jev-backed source can replace the title heuristic.\n4. Cover the chat → task switch note with a unit test.",
  },
  {
    id: "demo-effect-bump",
    projectId: "demo-t3code",
    title: "Bump effect to rc.116",
    provider: "codex",
    state: "done",
    minutesAgo: 2 * D,
    branch: "chore/effect-rc-116",
    settled: true,
    pullRequest: {
      number: 405,
      state: "merged",
      checks: "passing",
      review: "approved",
      additions: 42,
      deletions: 38,
      changedFiles: 6,
    },
    exchanges: [
      [
        "Bump effect to rc.116 and fix whatever breaks.",
        "Bumped. Two call sites used the removed `Effect.catchAllCause`; both now use `Effect.catchCause`. Typecheck and focused tests pass.",
      ],
    ],
    tools: ["Ran vp i", "Ran vp run typecheck --filter t3"],
  },
  {
    id: "demo-sidebar-rerender",
    projectId: "demo-t3code",
    title: "Why does the sidebar re-render on every keystroke?",
    provider: "cursor",
    state: "done",
    minutesAgo: 70,
    exchanges: [
      [
        "Why does the sidebar re-render on every keystroke in the composer?",
        "The composer draft lives in the same zustand store slice the sidebar subscribes to. Selecting `threads` with a shallow comparator stops it; the draft update no longer changes the selected value.",
      ],
    ],
    tools: ['Ran rg -n "useComposerDraftStore" apps/web/src', "Read Sidebar.tsx"],
  },
  {
    id: "demo-ws-payloads",
    projectId: "demo-t3code",
    title: "Audit websocket payload sizes",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 26,
    workMinutes: 12,
    exchanges: [
      [
        "mobile feels slow on cellular. audit what we send over the websocket when a thread opens. split it up with agents: server, web, mobile",
        "Three findings, biggest first:\n\n1. **Thread open ships every activity payload in full.** `tool.completed` rows keep the whole command output, so a 400-turn thread sends ~2.1 MB. Projecting those payloads the way `tool.updated` already is brings it to ~180 KB.\n2. **Reconnects resend the whole shell snapshot.** 41 KB of it is project rows that didn't change.\n3. **Mobile decodes the same snapshot twice**, once in `useShellSnapshot` and once in `threadListStore`: ~120 ms on a mid-range Android.\n\nNothing is edited yet. 1 is the obvious first fix.",
      ],
    ],
    tools: [
      {
        command: 'rg -n "projectActivityPayload" apps/server/src',
        output:
          "apps/server/src/orchestration/ActivityPayloadProjection.ts:41:export function projectActivityPayload(\napps/server/src/ws.ts:212:        activities: detail.activities.map(projectActivityPayload),",
      },
      "Read apps/server/src/orchestration/ActivityPayloadProjection.ts",
    ],
    subagents: [
      {
        id: "a41c7e2",
        title: "Measure thread-open payload on the server",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "completed",
        minutes: 6,
        result:
          "A 400-turn thread opens at 2.1 MB; 78% is tool.completed payload.data (raw command output).",
        tokens: 71_240,
        toolUses: 31,
      },
      {
        id: "b83d0f9",
        title: "Trace websocket traffic in the web client",
        role: "Explore",
        model: "claude-haiku-4-5",
        status: "completed",
        minutes: 4,
        result:
          "Web requests a full shell snapshot on every reconnect; 41 KB of it is unchanged project rows.",
        tokens: 38_750,
        toolUses: 18,
      },
      {
        id: "c5e2a61",
        title: "Profile snapshot decode on mobile",
        role: "Explore",
        model: "claude-haiku-4-5",
        status: "completed",
        minutes: 5,
        result:
          "useShellSnapshot and threadListStore both decode the same payload: ~120 ms per open on a Pixel 6a.",
        tokens: 45_120,
        toolUses: 20,
      },
    ],
    context: { usedTokens: 96_400, maxTokens: 200_000 },
  },
  {
    id: "demo-bundle-size",
    projectId: "demo-t3code",
    title: "Shrink the web bundle",
    provider: "claudeAgent",
    state: "interrupted",
    minutesAgo: 33,
    branch: "perf/web-bundle",
    exchanges: [
      [
        "web bundle is 3.4 MB. what's bloating it",
        "Three things account for most of it: shiki grammars (1.1 MB, every language loaded up front), `effect` bundled twice through two versions, and the emoji picker data (420 KB). Lazy-loading the shiki grammars is the biggest win.",
        [
          {
            command: "vp run build --filter @t3tools/web -- --mode analyze",
            output:
              "dist/assets/index-Bq3x.js      3,412.08 kB │ gzip: 968.21 kB\ndist/assets/shiki-langs-Dk2.js 1,104.55 kB │ gzip: 212.40 kB\n✓ built in 21.84s",
          },
          {
            command: "pnpm why effect",
            output:
              "effect 4.0.0-rc.116\n└─┬ @t3tools/client-runtime\neffect 4.0.0-rc.109\n└─┬ @t3tools/markdown-worker",
          },
        ],
      ],
      ["do the shiki one", null],
    ],
    tools: [
      "Read apps/web/src/markdown/highlighter.ts",
      "Edited apps/web/src/markdown/highlighter.ts",
      {
        command: "vp run build --filter @t3tools/web",
        output:
          "vite v8.1.2 building for production...\ntransforming (2318) src/markdown/highlighter.ts^C",
        exitCode: 130,
      },
    ],
  },
  // ── merchant-portal ────────────────────────────────────────────────────
  {
    id: "demo-refund-webhooks",
    projectId: "demo-merchant-portal",
    title: "Fix refund webhook retries",
    provider: "claudeAgent",
    state: "running",
    minutesAgo: 8,
    branch: "fix/refund-webhook-retries",
    worktree: true,
    pullRequest: {
      number: 87,
      state: "open",
      checks: "pending",
      review: "review-required",
      additions: 156,
      deletions: 23,
      changedFiles: 5,
    },
    exchanges: [
      [
        "Refund webhooks retry forever when the merchant returns 410. Stop retrying on 410 and cap backoff at 6 hours.",
        "Fixed. A 410 now marks the endpoint gone and stops retries, and backoff caps at 6 h. Two tests cover both. The loop went unnoticed because the retry job swallowed the response body.",
        [
          "Read src/webhooks/refunds.ts",
          "Edited src/webhooks/retryPolicy.ts",
          {
            command: "pnpm test src/webhooks",
            output:
              " ✓ src/webhooks/retryPolicy.test.ts (6 tests) 14ms\n ✓ src/webhooks/refunds.test.ts (9 tests) 31ms\n\n Test Files  2 passed (2)\n      Tests  15 passed (15)",
            exitCode: 0,
          },
        ],
      ],
      [
        "ok. check every other webhook type for the same bug and fix them all. use agents, it's a lot of files",
        null,
      ],
    ],
    tools: [
      {
        command: 'rg -ln "scheduleRetry" src/webhooks',
        output:
          "src/webhooks/refunds.ts\nsrc/webhooks/payouts.ts\nsrc/webhooks/disputes.ts\nsrc/webhooks/chargebacks.ts",
        exitCode: 0,
      },
    ],
    todos: [
      ["Audit every webhook type for 410 handling", "completed"],
      ["Move chargebacks onto retryPolicy", "inProgress"],
      ["Retry tests for each webhook type", "inProgress"],
      ["Update the retry section in docs/webhooks.md", "pending"],
    ],
    subagents: [
      {
        id: "e27b9d4",
        title: "Audit payout and dispute webhook retries",
        role: "Explore",
        model: "claude-haiku-4-5",
        status: "completed",
        minutes: 3,
        result:
          "payouts.ts and disputes.ts already go through retryPolicy.ts, so the 410 fix covers them. No other 410 handling exists.",
        tokens: 31_420,
        toolUses: 14,
      },
      {
        id: "f90c3a7",
        title: "Port chargeback retries onto retryPolicy",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "running",
        minutes: 0,
        progress: "chargebacks.ts has its own backoff loop; swapping it for retryPolicy.next()",
        lastTool: "Edit",
        tokens: 58_930,
        toolUses: 22,
      },
      {
        id: "0d4e8b1",
        title: "Write retry tests for every webhook type",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "running",
        minutes: 0,
        progress: "pnpm test src/webhooks: 3 of 5 suites green",
        lastTool: "Bash",
        tokens: 44_310,
        toolUses: 17,
      },
      {
        id: "1a6f2c5",
        title: "Check merchant endpoint logs for 410 loops",
        role: "Explore",
        model: "claude-haiku-4-5",
        status: "failed",
        minutes: 2,
        error:
          "fixtures/merchant-responses.jsonl is 212 MB. Read hit the size limit and grep timed out after 120s.",
        tokens: 9_870,
        toolUses: 5,
      },
    ],
  },
  {
    id: "demo-account-pools",
    projectId: "demo-merchant-portal",
    title: "Ship account pools page",
    provider: "codex",
    state: "done",
    minutesAgo: 35,
    branch: "feat/account-pools",
    worktree: true,
    pinKey: "n",
    pullRequest: {
      number: 84,
      state: "open",
      checks: "passing",
      review: "approved",
      additions: 912,
      deletions: 64,
      changedFiles: 19,
    },
    exchanges: [
      [
        "Build the account pools page: list pools, show balance per currency, and let admins move accounts between pools.",
        "Done. The page lists pools with per-currency balances, and moving an account is a single optimistic mutation with rollback on failure. Screenshots are in the MR.",
      ],
      [
        "Kira approved. Anything left before merge?",
        "Only the feature flag. It defaults off, so merging is safe; flip `account-pools` per merchant when ready.",
      ],
    ],
    tools: ["Created src/pages/AccountPools.tsx", "Ran pnpm test", "Opened !84"],
    checkpoints: [
      {
        "src/api/accountPools.ts": `export interface AccountPool {
  readonly id: string;
  readonly name: string;
  readonly balances: Readonly<Record<string, number>>;
  readonly accountIds: ReadonlyArray<string>;
}

export async function listAccountPools(): Promise<ReadonlyArray<AccountPool>> {
  const response = await fetch("/api/account-pools");
  if (!response.ok) throw new Error(\`account pools: \${response.status}\`);
  return response.json();
}

export async function moveAccount(accountId: string, toPoolId: string): Promise<void> {
  const response = await fetch(\`/api/accounts/\${accountId}/pool\`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ poolId: toPoolId }),
  });
  if (!response.ok) throw new Error(\`move account: \${response.status}\`);
}
`,
        "src/pages/AccountPools.tsx": `import { useAccountPools, useMoveAccount } from "./accountPoolQueries";
import { formatMinor } from "../money";

export function AccountPools() {
  const pools = useAccountPools();
  const moveAccount = useMoveAccount();
  if (pools.isPending) return <PoolsSkeleton />;
  return (
    <section aria-labelledby="pools-title">
      <h1 id="pools-title">Account pools</h1>
      {pools.data.map((pool) => (
        <article key={pool.id}>
          <h2>{pool.name}</h2>
          <dl>
            {Object.entries(pool.balances).map(([currency, amount]) => (
              <div key={currency}>
                <dt>{currency}</dt>
                <dd>{formatMinor(amount, currency)}</dd>
              </div>
            ))}
          </dl>
          <AccountList pool={pool} onMove={moveAccount.mutate} />
        </article>
      ))}
    </section>
  );
}
`,
      },
      {
        "src/flags.ts": `/** Per-merchant flags; flipped from the admin console. */
export const FLAGS = {
  "account-pools": false,
} as const;

export type FlagName = keyof typeof FLAGS;
`,
        "src/pages/AccountPools.tsx": `import { useAccountPools, useMoveAccount } from "./accountPoolQueries";
import { useFlag } from "../useFlag";
import { formatMinor } from "../money";

export function AccountPools() {
  const enabled = useFlag("account-pools");
  const pools = useAccountPools({ enabled });
  const moveAccount = useMoveAccount();
  if (!enabled) return null;
  if (pools.isPending) return <PoolsSkeleton />;
  return (
    <section aria-labelledby="pools-title">
      <h1 id="pools-title">Account pools</h1>
      {pools.data.map((pool) => (
        <article key={pool.id}>
          <h2>{pool.name}</h2>
          <dl>
            {Object.entries(pool.balances).map(([currency, amount]) => (
              <div key={currency}>
                <dt>{currency}</dt>
                <dd>{formatMinor(amount, currency)}</dd>
              </div>
            ))}
          </dl>
          <AccountList pool={pool} onMove={moveAccount.mutate} />
        </article>
      ))}
    </section>
  );
}
`,
      },
    ],
  },
  {
    id: "demo-3ds-fallback",
    projectId: "demo-merchant-portal",
    title: "Add 3DS challenge fallback",
    provider: "codex",
    state: "approval",
    minutesAgo: 14,
    branch: "feat/3ds-fallback",
    exchanges: [
      [
        "When the 3DS iframe fails to load, fall back to a redirect challenge.",
        "The fallback is wired. It needs a new column for the redirect URL, so I have to run the migration.",
      ],
    ],
    tools: [
      "Read ThreeDSChallenge.tsx",
      "Edited ThreeDSChallenge.tsx",
      "Created migrations/0042_add_3ds_redirect_url.sql",
    ],
    approval: "pnpm db:migrate --name add_3ds_redirect_url",
  },
  {
    id: "demo-api-versioning",
    projectId: "demo-merchant-portal",
    title: "How do we version the merchant API?",
    provider: "opencode",
    state: "done",
    minutesAgo: 5 * H,
    exchanges: [
      [
        "How do we version the merchant API today, and what would date-based versioning cost us?",
        "Today it's URL-prefixed (`/v2/`). Date-based versioning (Stripe-style) means pinning each merchant to a version and translating responses at the edge. It costs one translation layer per breaking change but removes big-bang migrations.",
      ],
    ],
    tools: ['Ran rg -n "/v2/" src/api', "Read docs/api/versioning.md"],
  },
  {
    id: "demo-payouts-cents",
    projectId: "demo-merchant-portal",
    title: "Migrate payouts table to cents",
    provider: "claudeAgent",
    state: "plan",
    minutesAgo: 2 * H,
    exchanges: [
      ["Plan the migration of payouts.amount from decimal to integer cents.", "Plan below."],
    ],
    tools: ["Read db/schema/payouts.ts", 'Ran rg -n "payouts.amount" src'],
    plan: "# Payouts to integer cents\n\n1. Add `amount_minor BIGINT` alongside `amount`.\n2. Backfill in batches of 10k using currency exponent (JPY = 0, KWD = 3).\n3. Dual-write for one release.\n4. Switch reads, then drop `amount`.",
  },
  {
    id: "demo-settlement-review",
    projectId: "demo-merchant-portal",
    title: "Review Kira's settlement export MR",
    provider: "cursor",
    state: "done",
    minutesAgo: 6 * H,
    branch: "review/settlement-export",
    snoozeHours: 20,
    exchanges: [
      [
        "Review Kira's settlement export MR and list anything blocking.",
        "Two blockers: the CSV uses the server timezone instead of the merchant's, and totals are summed in floating point. The rest is style.",
      ],
    ],
    tools: ["Ran git diff develop...review/settlement-export", "Read src/exports/settlementCsv.ts"],
  },
  {
    id: "demo-error-codes",
    projectId: "demo-merchant-portal",
    title: "Update Stripe-compatible error codes",
    provider: "codex",
    state: "done",
    minutesAgo: 9 * D,
    archived: true,
    exchanges: [
      [
        "Update the error code map to match the Stripe-compatible list.",
        "14 codes changed in `src/errors/stripeCodes.ts`, mostly `card_declined` sub-reasons. `processing_error` had no match, so it maps to `api_error` like before. Tests pass.",
      ],
    ],
    tools: ["Read docs/error-codes.md", "Edited src/errors/stripeCodes.ts", "Ran pnpm test errors"],
  },
  {
    id: "demo-flaky-checkout",
    projectId: "demo-merchant-portal",
    title: "Fix flaky checkout e2e test",
    provider: "codex",
    state: "failed",
    minutesAgo: 22,
    branch: "fix/flaky-checkout-e2e",
    workMinutes: 6,
    exchanges: [
      [
        "checkout.spec.ts fails like 1 in 5 runs on CI. find out why",
        "It's a race. The test clicks Pay before the 3DS iframe posts `ready`, so the click lands on the spinner overlay. Waiting for the `ready` message fixes it locally: 50 of 50 runs pass.",
        [
          {
            command: "pnpm playwright test e2e/checkout.spec.ts --repeat-each=20",
            output:
              "Running 20 tests using 4 workers\n  ✘ 7 [chromium] › checkout.spec.ts:41:3 › pays with a 3DS challenge (2.1s)\n    Error: locator.click: Element is not visible\n  16 passed, 4 failed (38.2s)",
            exitCode: 1,
          },
          "Read e2e/checkout.spec.ts",
          "Edited e2e/checkout.spec.ts",
          {
            command: "pnpm playwright test e2e/checkout.spec.ts --repeat-each=50",
            output: "Running 50 tests using 4 workers\n  50 passed (1.4m)",
            exitCode: 0,
          },
        ],
      ],
      ["run it 200 times on the CI image to be sure", null],
    ],
    tools: [
      {
        command:
          "docker run --rm -v $PWD:/app -w /app ci-node:22 pnpm playwright test e2e/checkout.spec.ts --repeat-each=200 --workers=4",
        output: "Running 200 tests using 4 workers\n  ··························",
        exitCode: 137,
      },
    ],
    error:
      "stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)",
  },
  {
    id: "demo-ledger-port",
    projectId: "demo-merchant-portal",
    title: "Port settlement jobs to the ledger service",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 80,
    branch: "feat/ledger-settlements",
    workMinutes: 9,
    exchanges: [
      [
        "We're moving settlement off the monolith onto the ledger service. Start with the daily settlement job.",
        "The daily job now posts one ledger transaction per merchant instead of updating `settlements` rows. It runs behind `ledger-settlements`, and in dry-run mode it compares both totals and logs mismatches.",
        [
          "Read src/jobs/dailySettlement.ts",
          "Created src/ledger/client.ts",
          "Edited src/jobs/dailySettlement.ts",
        ],
      ],
      [
        "dry run found 3 mismatches on yesterday's data",
        "All three are merchants with refunds crossing midnight UTC. The old job books refunds by creation time, the ledger by capture time. The ledger is right; I added the cutoff to the comparison so dry-run stops flagging them.",
        [
          {
            command: "pnpm tsx scripts/settlement-dry-run.ts --date 2026-09-28",
            output:
              "compared 1,284 merchants\nmismatch m_3321 CHF 42.10\nmismatch m_7810 EUR 9.90\nmismatch m_9054 CHF 120.00",
            exitCode: 0,
          },
        ],
      ],
      [
        "now the weekly payout job",
        "Weekly payouts read balances from the ledger now. The payout file format didn't change, so the bank upload is untouched.",
        ["Read src/jobs/weeklyPayouts.ts", "Edited src/jobs/weeklyPayouts.ts"],
      ],
      [
        "and the monthly fee invoices",
        "Fee invoices come from ledger fee entries now. One catch: fees for merchants on legacy plans were computed at invoice time, so I backfilled those as ledger entries for the last 13 months (4,112 entries, dry-run first).",
        [
          "Read src/jobs/monthlyFees.ts",
          "Created migrations/0051_backfill_legacy_fees.sql",
          {
            command: "pnpm db:migrate --dry-run",
            output: "0051_backfill_legacy_fees.sql: 4,112 rows would be inserted",
            exitCode: 0,
          },
        ],
      ],
      [
        "run the whole settlement suite",
        "All green: 212 tests across the three jobs, plus the dry-run comparison against last month's data with zero mismatches.",
        [
          {
            command: "pnpm test src/jobs src/ledger",
            output:
              " Test Files  14 passed (14)\n      Tests  212 passed (212)\n   Duration  18.42s",
            exitCode: 0,
          },
        ],
      ],
      [
        "write up what's left before we can drop the old settlements table",
        "Four things are left:\n\n1. Flip `ledger-settlements` on for all merchants and watch one full month-end close.\n2. Point the finance CSV export at ledger balances; it still reads `settlements`.\n3. Delete the dual-write in `dailySettlement.ts`.\n4. Drop `settlements` after the 90-day audit retention window.\n\nThe context window is nearly full, so start a fresh thread for the export work.",
      ],
    ],
    tools: ['Ran rg -ln "from settlements" src', "Read src/exports/financeCsv.ts"],
    compaction: { turn: 3, beforeTokens: 187_240, afterTokens: 41_380 },
    context: { usedTokens: 181_300, maxTokens: 200_000 },
  },
  // ── terminal-app ────────────────────────────────────────────────────────
  {
    id: "demo-printer-timeout",
    projectId: "demo-terminal-app",
    title: "Debug PAX A920 printer timeout",
    provider: "codex",
    state: "input",
    minutesAgo: 18,
    branch: "fix/a920-printer-timeout",
    worktree: true,
    exchanges: [
      [
        "Receipts time out on the A920 after the second print. Find out why.",
        "The Neptune printer handle is never closed after the first job. Before I patch it, I need the firmware version, since the close semantics changed.",
      ],
    ],
    tools: ["Read Printer.kt", "Read Neptune IPrinter javadoc"],
    question: {
      header: "Firmware",
      question: "Which PayDroid firmware is the failing A920 on?",
      options: ["PayDroid 8.1", "PayDroid 10", "Not sure"],
    },
  },
  {
    id: "demo-neptune-events",
    projectId: "demo-terminal-app",
    title: "Wire Neptune card reader events",
    provider: "cursor",
    state: "running",
    minutesAgo: 7,
    branch: "feat/neptune-card-events",
    worktree: true,
    exchanges: [
      ["Expose card inserted, tapped, and removed events from the Neptune reader as a Flow.", null],
    ],
    tools: ["Read Neptune IPicc javadoc", "Edited CardReader.kt"],
  },
  {
    id: "demo-receipt-preview",
    projectId: "demo-terminal-app",
    title: "Build receipt layout preview",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 1 * D,
    branch: "feat/receipt-preview",
    settled: true,
    pullRequest: {
      number: 52,
      state: "merged",
      checks: "passing",
      review: "approved",
      additions: 340,
      deletions: 12,
      changedFiles: 7,
    },
    exchanges: [
      [
        "Build a receipt layout preview so we can check line wrapping without printing.",
        "The preview renders the same 384px bitmap the printer gets, so wrapping matches exactly.",
      ],
    ],
    tools: ["Created ReceiptPreview.kt", "Ran ./gradlew testDebugUnitTest"],
  },
  {
    id: "demo-android-7",
    projectId: "demo-terminal-app",
    title: "Should we drop Android 7 support?",
    provider: "grok",
    state: "done",
    minutesAgo: 3 * H,
    snoozeHours: 72,
    exchanges: [
      [
        "Should we drop Android 7 support on terminals?",
        "Only the A920 fleet still runs it (about 8% of devices). Dropping it unlocks the newer Neptune SDK, but you'd need a firmware push first.",
      ],
    ],
    tools: ["Read docs/fleet/android-versions.md"],
  },
  {
    id: "demo-tip-rounding",
    projectId: "demo-terminal-app",
    title: "Fix tip screen rounding",
    provider: "codex",
    state: "done",
    minutesAgo: 12 * D,
    archived: true,
    exchanges: [
      [
        "Tips of 15% round the wrong way on CHF 0.05.",
        "The tip was rounded before the percentage was applied. It now rounds the final tip to the nearest CHF 0.05, so 15% of CHF 12.30 shows CHF 1.85 instead of CHF 1.80. Added cases for the .025 boundaries.",
      ],
    ],
    tools: ["Edited TipCalculator.kt", "Ran ./gradlew test --tests TipCalculatorTest"],
  },
  {
    id: "demo-gradle-cache",
    projectId: "demo-terminal-app",
    title: "Speed up the Gradle build",
    provider: "codex",
    state: "running",
    minutesAgo: 3,
    branch: "chore/gradle-config-cache",
    exchanges: [
      [
        "clean builds take 4+ min on my machine. make it faster without touching the Neptune SDK",
        null,
      ],
    ],
    tools: [
      {
        command: "./gradlew assembleDebug --profile",
        output:
          "BUILD SUCCESSFUL in 4m 12s\n187 actionable tasks: 187 executed\n\nSee the profiling report at: build/reports/profile/profile-2026-09-30-14-02-11.html",
        exitCode: 0,
      },
      {
        command: "cat gradle.properties",
        output: "org.gradle.jvmargs=-Xmx2048m\nandroid.useAndroidX=true",
        exitCode: 0,
      },
    ],
    reasoning:
      "**Checking why the configuration cache is off**\n\nThe profile spends 48s in configuration before any task runs. `gradle.properties` doesn't set `org.gradle.configuration-cache`, and the heap is capped at 2 GB, so the daemon is probably GC-bound during dexing too. The Neptune SDK plugin reads `System.getenv(\"NEPTUNE_HOME\")` at configuration time, which would invalidate the cache on every run. I can't change the plugin, but I can pass that through a `providers.environmentVariable` in the app module instead and leave the SDK untouched…",
  },
  // ── northwind-docs ─────────────────────────────────────────────────────────
  {
    id: "demo-terminal-onboarding",
    projectId: "demo-northwind-docs",
    title: "Write terminal onboarding guide",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 55,
    branch: "docs/terminal-onboarding",
    pullRequest: {
      number: 31,
      state: "open",
      checks: "failing",
      review: "changes-requested",
      additions: 220,
      deletions: 4,
      changedFiles: 3,
    },
    exchanges: [
      [
        "Write the onboarding guide for merchants setting up their first terminal.",
        "Drafted: unboxing, pairing with the portal, first test transaction, and troubleshooting. The link checker fails on `#pair-the-terminal`: the pairing guide renamed that heading. I left the anchor alone because merchants may have bookmarked it; renaming the heading back fixes CI.",
      ],
    ],
    tools: ["Created docs/terminals/onboarding.md", "Ran pnpm lint:links"],
  },
  {
    id: "demo-sandbox-keys",
    projectId: "demo-northwind-docs",
    title: "Rename sandbox keys section",
    provider: "opencode",
    state: "done",
    minutesAgo: 3 * D,
    settled: true,
    exchanges: [
      [
        "Rename 'Sandbox keys' to 'Test credentials' everywhere.",
        "Renamed across 11 pages with redirects.",
      ],
    ],
    tools: ['Ran rg -l "Sandbox keys" docs', "Edited 11 pages", "Edited redirects.json"],
  },
  {
    id: "demo-webhook-docs",
    projectId: "demo-northwind-docs",
    title: "What's missing from the webhook docs?",
    provider: "grok",
    state: "done",
    minutesAgo: 4 * H,
    exchanges: [
      [
        "What's missing from the webhook docs?",
        "Retry schedule, signature verification examples beyond Node, and the 410 behavior. The retry fix in merchant-portal changes that last one.",
      ],
    ],
    tools: ["Read docs/webhooks/retries.md", 'Ran rg -n "410" docs/webhooks'],
  },
  {
    id: "demo-docs-samples",
    projectId: "demo-northwind-docs",
    title: "Check every code sample in the docs",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 2 * H,
    workMinutes: 18,
    exchanges: [
      [
        "run every code sample in the docs against the sandbox and tell me which ones are broken",
        "Checked 41 runnable samples out of 64:\n\n- **Broken (1):** the refund curl sample still sends `reason`, which the API dropped. It returns 400.\n- **Deprecated (2):** two Node samples use `northwind.init()`; they work but log a warning.\n- **Unverified (9):** the PHP samples. The sandbox image has no PHP 8.3, so that agent couldn't install dependencies.\n\nThe full list is in `reports/sample-check.md`. Want me to fix the curl one and the two Node ones?",
      ],
    ],
    tools: [
      {
        command: 'rg -c "```(bash|js|php)" docs',
        output: "docs/refunds.md:6\ndocs/webhooks.md:9\ndocs/terminal/onboarding.md:3\n…",
        exitCode: 0,
      },
    ],
    workflow: {
      id: "wf-sample-check",
      name: "docs-sample-check",
      phases: ["Discover", "Verify", "Report"],
      summary: "41 samples checked: 1 broken, 2 deprecated, 9 unverified (PHP).",
    },
    subagents: [
      {
        id: "discover",
        title: "Find runnable code samples",
        role: "Explore",
        model: "claude-haiku-4-5",
        status: "completed",
        minutes: 3,
        result: "64 fenced samples across 23 pages; 41 are runnable (curl, Node, PHP).",
        tokens: 22_400,
        toolUses: 11,
        phase: 0,
      },
      {
        id: "verify-curl",
        title: "Run curl samples against the sandbox",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "completed",
        minutes: 7,
        result: "19 of 20 pass. POST /refunds still sends `reason` and gets a 400.",
        tokens: 54_800,
        toolUses: 26,
        phase: 1,
      },
      {
        id: "verify-node",
        title: "Compile and run Node samples",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "completed",
        minutes: 6,
        result: "All 12 run. Two call the deprecated northwind.init() and log a warning.",
        tokens: 47_150,
        toolUses: 21,
        phase: 1,
      },
      {
        id: "verify-php",
        title: "Run PHP samples",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "failed",
        minutes: 4,
        error:
          "composer install failed: requires php ^8.3, sandbox image has 8.1. 9 samples unverified.",
        tokens: 18_020,
        toolUses: 9,
        phase: 1,
      },
      {
        id: "report",
        title: "Write the sample report",
        role: "general-purpose",
        model: "claude-fable-5-1",
        status: "completed",
        minutes: 2,
        result: "Wrote reports/sample-check.md with page, sample, and failure for each finding.",
        tokens: 12_600,
        toolUses: 4,
        phase: 2,
      },
    ],
  },
  // ── appa-vm ─────────────────────────────────────────────────────────────
  {
    id: "demo-cloud-init",
    projectId: "demo-appa-vm",
    title: "Fix cloud-init network race",
    provider: "opencode",
    state: "running",
    minutesAgo: 11,
    branch: "fix/cloud-init-network",
    exchanges: [
      [
        "cloud-init sometimes runs before the bridge is up and package installs fail. Fix the ordering.",
        null,
      ],
    ],
    tools: ["Read cloud-init/user-data.yaml"],
  },
  {
    id: "demo-nixos-migration",
    projectId: "demo-appa-vm",
    title: "Migrate appa to NixOS 26.05",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 1 * D,
    branch: "chore/nixos-26-05",
    snoozeHours: 6 * 24,
    exchanges: [
      [
        "Migrate appa to NixOS 26.05 once it's out.",
        "The flake on `chore/nixos-26-05` points at the 26.05 release branch, and `nixos-rebuild build` passes. Nothing is switched yet: 26.05 isn't tagged, so the branch pins a moving target until it is.",
      ],
    ],
    tools: ["Edited flake.nix", "Ran nixos-rebuild build --flake .#appa"],
  },
  {
    id: "demo-gpu-passthrough",
    projectId: "demo-appa-vm",
    title: "Can Appa run a GPU passthrough?",
    provider: "grok",
    state: "done",
    minutesAgo: 4 * D,
    settled: true,
    exchanges: [
      [
        "Can Appa run a GPU passthrough for local models?",
        "Yes, if IOMMU groups separate the GPU. Your board puts it alone in group 14, so VFIO passthrough works.",
      ],
    ],
    tools: ["Ran ls /sys/kernel/iommu_groups/*/devices"],
  },
  {
    id: "demo-sshd-hardening",
    projectId: "demo-appa-vm",
    title: "Harden sshd on appa",
    provider: "codex",
    state: "approval",
    minutesAgo: 16,
    branch: "chore/sshd-hardening",
    exchanges: [
      [
        "lock down ssh on appa. keys only, no root, and fail2ban",
        "The patch is ready: password and root login off, ed25519 host keys only, `MaxAuthTries 3`, and fail2ban on the sshd jail. It rewrites the host's sshd module, so it needs your OK before I write it.",
      ],
    ],
    tools: [
      "Read hosts/appa/configuration.nix",
      {
        command: "nix eval .#nixosConfigurations.appa.config.services.openssh.settings --json",
        output:
          '{"KbdInteractiveAuthentication":true,"PasswordAuthentication":true,"PermitRootLogin":"prohibit-password"}',
        exitCode: 0,
      },
    ],
    approval: "hosts/appa/sshd.nix: keys only, no root login, fail2ban jail (+14 −3)",
    approvalKind: "file-change",
  },
  // ── dotfiles ────────────────────────────────────────────────────────────
  {
    id: "demo-fish-port",
    projectId: "demo-dotfiles",
    title: "Port zsh config to fish",
    provider: "cursor",
    state: "done",
    minutesAgo: 90,
    branch: "feat/fish",
    exchanges: [
      [
        "Port my zsh aliases and env to fish.",
        "Ported 23 aliases to abbreviations and moved env vars into `conf.d/env.fish`.",
      ],
    ],
    tools: ["Read .zshrc", "Created conf.d/env.fish", "Ran fish --no-execute config.fish"],
  },
  {
    id: "demo-ghostty-theme",
    projectId: "demo-dotfiles",
    title: "Add ghostty theme toggle",
    provider: "codex",
    state: "done",
    minutesAgo: 2 * D,
    pinKey: "t",
    settled: true,
    exchanges: [
      [
        "Add a keybind to toggle ghostty between light and dark.",
        "Bound to cmd+shift+t; it follows the system appearance until you toggle.",
      ],
    ],
    tools: ["Edited ghostty/config"],
  },
  {
    id: "demo-brew-casks",
    projectId: "demo-dotfiles",
    title: "Remove stale brew casks",
    provider: "opencode",
    state: "done",
    minutesAgo: 15 * D,
    archived: true,
    exchanges: [
      [
        "Remove casks I haven't opened in 90 days.",
        "Removed 9 casks, 4.1 GB freed. Kept the two with launch agents still loaded, since removing those breaks login items.",
      ],
    ],
    tools: ["Ran brew list --cask", "Ran brew uninstall --cask (9 casks)"],
  },
  // ── notes ──────────────────────────────────────────────────────────────
  {
    id: "demo-skydiving",
    projectId: "demo-notes",
    title: "Should I go skydiving",
    provider: "claudeAgent",
    state: "done",
    minutesAgo: 40,
    exchanges: [
      [
        "Should I go skydiving? Never done it before.",
        "For a first jump, do a tandem: one short briefing and an instructor handles everything. If you like it, a solo course is the next step. Check the drop zone's age and health requirements before you book.",
      ],
    ],
  },
  {
    id: "demo-meal-plan",
    projectId: "demo-notes",
    title: "Plan meals for next week",
    provider: "grok",
    state: "done",
    minutesAgo: 20 * H,
    exchanges: [
      [
        "Plan easy dinners for next week. I want to cook twice and eat well all week.",
        "The 7-day plan is in `meals/week-40.md`, built around two batch-cooked bases: lentil chili and a tray of roast vegetables with rice. Each base covers three or four dinners with a different topping; the shopping list is at the bottom.",
      ],
    ],
    tools: ["Read recipes.md", "Created meals/week-40.md"],
  },
  {
    id: "demo-protein",
    projectId: "demo-notes",
    title: "How much protein do I need?",
    provider: "codex",
    state: "done",
    minutesAgo: 5 * D,
    settled: true,
    exchanges: [
      [
        "How much protein do I need a day if I lift a few times a week?",
        "Common guidance for people who train is 1.6-2.2 g per kg of body weight a day, spread across meals.",
      ],
    ],
  },
];
