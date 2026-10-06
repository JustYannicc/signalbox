import { WATCH_PULL_REQUEST } from "../../defaults/watchPullRequest.ts";

/**
 * Complete automations agents start from, installed as `references/examples/<name>`.
 * A test compiles every one, so they stay valid as the SDK changes.
 */
export const EXAMPLES: Readonly<Record<string, string>> = {
  // The built-in, exactly as it runs.
  "watch-pull-request.ts": WATCH_PULL_REQUEST,
  "rss-digest.ts": `import Parser from "rss-parser";

export const meta = {
  name: "Morning reading digest",
  description: "Every weekday at 7, reads my feeds, skips what I've seen, and sends a short digest of what's worth reading.",
  intent: "every morning summarize what's new in my feeds and tell me what's worth reading",
  triggers: [{ cron: "0 7 * * 1-5", timezone: "Europe/Zurich" }],
} as const;

const FEEDS = ["https://blog.cloudflare.com/rss/", "https://vercel.com/atom"];

/** Fetches and parses every feed; returns the newest items. */
async function readFeeds(urls: string[]) {
  const parser = new Parser();
  const feeds = await Promise.all(urls.map((url) => parser.parseURL(url)));
  return feeds.flatMap((feed) =>
    feed.items.slice(0, 20).map((item) => ({
      id: item.guid ?? item.link ?? item.title ?? "",
      title: item.title ?? "",
      link: item.link ?? "",
      source: feed.title ?? "",
      summary: (item.contentSnippet ?? "").slice(0, 600),
    })),
  );
}

export default workflow(async (w) => {
  const items = await w.run("Read the feeds", readFeeds, FEEDS);
  const seen: string[] = (await w.recall("What I've already sent", "seen")) ?? [];
  const fresh = items.filter((item) => !seen.includes(item.id));
  // Anything new?
  if (fresh.length === 0) return "nothing new";

  const picks = await w.extract("Pick what's worth reading", {
    input: fresh,
    schema: { picks: [{ id: "string", why: "string" }] },
  });
  const digest = await w.llm("Write the digest", {
    prompt: "A short morning digest: one line per pick with its link and why it matters. No intro.",
    input: { picks: picks.picks, items: fresh },
  });
  await w.notify("Your reading digest", digest);
  await w.remember("Remember what was sent", "seen", [...seen, ...fresh.map((item) => item.id)].slice(-2000));
  return { new: fresh.length, picked: picks.picks.length };
});
`,
  "support-email.ts": `export const meta = {
  name: "Triage support emails",
  description: "Sort each support email, draft a reply, and ask me before sending.",
  intent: "when a support email comes in, sort it and draft a reply I can approve",
  triggers: [{ webhook: true }],
} as const;

export default workflow(async (w, email: { from: string; subject: string; body: string }) => {
  const kind = await w.judge("What kind of email is it?", { input: email, outcomes: ["question", "bug", "spam"] });
  if (kind === "spam") return "ignored";

  const draft = await w.llm("Draft a reply", { prompt: \`Write a short, friendly reply to:\\n\${email.body}\` });
  // Send it? The user can edit the draft first.
  const answer = await w.ask("Send this reply?", {
    fields: { reply: { type: "longText", default: draft, required: true } },
    options: ["send", "skip"],
  });
  if (answer.choice === "send") {
    await w.call("Send the reply", "gmail.users.messages.send", { userId: "me", to: email.from, text: answer.values.reply });
  }
  if (kind === "bug") {
    await w.agent("Look into the bug", { prompt: \`A customer reported: \${email.body}\`, worktree: "main" });
  }
});
`,
  "sync-stripe-to-sheet.ts": `export const meta = {
  name: "Log new Stripe payments",
  description: "Every hour, appends new Stripe payments to the finance sheet and flags large ones.",
  intent: "put every new stripe payment in the finance sheet and tell me about big ones",
  triggers: [{ cron: "15 * * * *", timezone: "Europe/Zurich" }],
} as const;

const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

export default workflow(async (w) => {
  const since: number = (await w.recall("Last payment time", "since")) ?? Math.floor(Date.now() / 1000) - 3600;
  const payments: Array<{ id: string; amount: number; currency: string; created: number; description: string | null }> = [];
  let startingAfter: string | null = null;
  // More pages?
  for (let page = 0; page < 20; page++) {
    const result = await w.call("List payments", "stripe.charges.list", {
      created: { gt: since },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    payments.push(...result.data);
    if (!result.has_more) break;
    startingAfter = result.data[result.data.length - 1].id;
  }
  // Any new payments?
  if (payments.length === 0) return "no new payments";

  await w.call("Append to the sheet", "google_sheets.spreadsheets.values.append", {
    spreadsheetId: SHEET,
    range: "Payments!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: payments.map((p) => [
        new Date(p.created * 1000).toISOString().slice(0, 10),
        p.id,
        p.amount / 100,
        p.currency.toUpperCase(),
        p.description ?? "",
      ]),
    },
  });
  const large = payments.filter((p) => p.amount >= 100_000);
  // Any big ones?
  if (large.length > 0) {
    await w.notify("Large payments", large.map((p) => \`\${p.amount / 100} \${p.currency.toUpperCase()}: \${p.description ?? p.id}\`).join("\\n"), { importance: "high" });
  }
  await w.remember("Save the time", "since", Math.max(...payments.map((p) => p.created)));
  return { logged: payments.length, large: large.length };
});
`,
  "work-through-tickets.ts": `import { execFileSync } from "node:child_process";

export const meta = {
  name: "Work through GitHub tickets",
  description:
    "Builds a set of GitHub issues in blocker order. Each ticket gets its own agent and pull request, and merges once the required check is green and an independent review passes. That unblocks the next tickets.",
  intent:
    "Write an automation once that does a set of tickets from start to finish in their order, with no model supervising, and tells me when it needs me or is done.",
} as const;

interface Settings {
  /** owner/name on GitHub. */
  repo: string;
  /** The issues to deliver. Their blocked-by links on GitHub decide the order. */
  tickets: number[];
  /** Issues another thread is already building: wait for their pull request instead. */
  external?: number[];
  /** The check that must pass before merging. */
  check?: string;
  /** How many tickets are built at the same time. */
  atOnce?: number;
  builder?: { provider: string; model: string; effort?: string };
  reviewer?: { provider: string; model: string; effort?: string };
}
interface Ticket {
  number: number;
  title: string;
  url: string;
  closed: boolean;
  blockedBy: Array<{ number: number; open: boolean }>;
}
interface PullRequest {
  number: number;
  url: string;
  branch: string;
  merged: boolean;
}
type Landing = { merged: true } | { merged: false; why: string };

const DEFAULT_BUILDER = { provider: "claudeAgent", model: "claude-opus-5-5", effort: "high" };
const DEFAULT_REVIEWER = { provider: "codex", model: "gpt-6-astra", effort: "high" };

// ---------- Runs on the machine, through w.run ----------

function gh(args: string[]): string {
  try {
    return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string; message: string };
    throw new Error(failed.stderr?.trim() || failed.stdout?.trim() || failed.message);
  }
}
const ghJson = (args: string[]) => JSON.parse(gh(args));
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readTickets(repo: string, numbers: number[]): Ticket[] {
  return numbers.map((number) => {
    const issue = ghJson(["issue", "view", String(number), "-R", repo, "--json", "title,state,url"]);
    const blockers = ghJson(["api", \`repos/\${repo}/issues/\${number}/dependencies/blocked_by\`]);
    return {
      number,
      title: issue.title,
      url: issue.url,
      closed: issue.state === "CLOSED",
      blockedBy: blockers.map((blocker: { number: number; state: string }) => ({
        number: blocker.number,
        open: blocker.state === "open",
      })),
    };
  });
}

/** A pull request that closes the issue, or one from the branch its agent was given. */
function findPullRequest(repo: string, issue: number, branch: string): PullRequest | null {
  const linked = ghJson(["issue", "view", String(issue), "-R", repo, "--json", "closedByPullRequestsReferences"]);
  const fromBranch = ghJson(["pr", "list", "-R", repo, "--head", branch, "--state", "all", "--json", "number"]);
  const numbers = [
    ...(linked.closedByPullRequestsReferences ?? []).map((pr: { number: number }) => pr.number),
    ...fromBranch.map((pr: { number: number }) => pr.number),
  ];
  for (const number of numbers) {
    const pr = ghJson(["pr", "view", String(number), "-R", repo, "--json", "number,url,headRefName,state"]);
    if (pr.state !== "CLOSED") {
      return { number: pr.number, url: pr.url, branch: pr.headRefName, merged: pr.state === "MERGED" };
    }
  }
  return null;
}

/** Looks for the pull request once a minute for up to \`minutes\`. */
function waitForPullRequest(repo: string, issue: number, branch: string, minutes: number) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const pr = findPullRequest(repo, issue, branch);
    if (pr || Date.now() > deadline) return pr;
    pause(60_000);
  }
}

/** The pull request's checks. \`gh pr checks\` exits non-zero while any are pending or failing, but still lists them. */
function listChecks(repo: string, number: number): Array<{ name: string; bucket: string; link: string }> {
  try {
    const args = ["pr", "checks", String(number), "-R", repo, "--json", "name,bucket,link"];
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    // Right after a push, GitHub hasn't registered any checks yet.
    if (/no checks reported/i.test(failed.stderr ?? "")) return [];
    if (failed.stdout?.trim()) return JSON.parse(failed.stdout);
    throw new Error(failed.stderr?.trim() || failed.message);
  }
}

/** Watches the pull request for up to \`minutes\` until it's green, red, conflicting or closed. */
function checkPullRequest(repo: string, number: number, check: string, minutes: number) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const pr = ghJson(["pr", "view", String(number), "-R", repo, "--json", "state,mergeable"]);
    if (pr.state === "MERGED") return { state: "merged" as const, failed: [] };
    if (pr.state === "CLOSED") return { state: "closed" as const, failed: [] };
    if (pr.mergeable === "CONFLICTING") return { state: "conflict" as const, failed: [] };
    const checks = listChecks(repo, number);
    const required = checks.find((candidate) => candidate.name === check);
    if (required?.bucket === "pass") return { state: "green" as const, failed: [] };
    if (required?.bucket === "fail" || required?.bucket === "cancel") {
      const failed = checks.filter((candidate) => candidate.bucket === "fail" || candidate.bucket === "cancel");
      return { state: "red" as const, failed: failed.map((candidate) => \`\${candidate.name}: \${candidate.link}\`) };
    }
    if (Date.now() > deadline) return { state: "pending" as const, failed: [] };
    pause(30_000);
  }
}

/** Squash-merges through the API, so no local checkout is touched, then deletes the branch. */
function mergePullRequest(repo: string, number: number) {
  const pr = ghJson(["pr", "view", String(number), "-R", repo, "--json", "headRefName"]);
  let merged = false;
  let error: string | null = null;
  try {
    const result = ghJson(["api", "-X", "PUT", \`repos/\${repo}/pulls/\${number}/merge\`, "-f", "merge_method=squash"]);
    merged = result.merged === true;
    if (!merged) error = result.message ?? "GitHub didn't merge it.";
  } catch (failure) {
    error = String((failure as Error).message).slice(0, 2000);
  }
  // Only a merged branch is deleted: deleting an open pull request's branch closes it.
  if (merged) {
    try {
      gh(["api", "-X", "DELETE", \`repos/\${repo}/git/refs/heads/\${pr.headRefName}\`]);
    } catch {
      // The branch may already be gone.
    }
  }
  return { ok: merged, error };
}

// ---------- Prompts ----------

const buildPrompt = (repo: string, ticket: Ticket, branch: string, check: string) => \`Implement \${repo}#\${ticket.number}: "\${ticket.title}" (\${ticket.url}).

You're on branch \\\`\${branch}\\\`, fresh from origin/main. Read the repository's agent instructions (AGENTS.md or CLAUDE.md, if there are any), the ticket, and the issues it links before writing code. Stay inside the ticket's scope; note anything outside it as a comment on the ticket instead of building it.

When the ticket's done and focused checks pass, commit, push \\\`\${branch}\\\`, and open a pull request against main with a conventional title and "Closes #\${ticket.number}" in the body. If the link_pull_request tool is available, register it. Don't merge it: an automation merges once the \${check} check is green and a separate review passes.

If you need an account, key or decision only a person can give, ask through request_secret or a question and wait. Never put secrets in chat or code.\`;

const reviewPrompt = (repo: string, ticket: Ticket, pr: PullRequest) => \`Review pull request \${pr.url}, which implements \${repo}#\${ticket.number} ("\${ticket.title}", \${ticket.url}).

You're on a checkout of its branch. Don't edit files or push. Check it against the ticket, the repository's agent instructions if any, and the issues the ticket links. Read the review comments bots left on the pull request (gh pr view \${pr.number} -R \${repo} --comments) and verify each one against the code. Run focused checks where they settle a question.

End with exactly one line: "VERDICT: merge" when it can merge as is, or "VERDICT: fix" followed by a numbered list of what must change. Only list problems that matter; leave style to the tooling.\`;

const fixPrompt = (problem: string, pr: PullRequest, ownThread: boolean) =>
  \`\${problem}\\n\\nFix it on the pull request \${pr.url}, run focused checks, commit and push.\` +
  (ownThread
    ? ""
    : \` You're on a new branch made from \\\`\${pr.branch}\\\`; push with \\\`git push origin HEAD:\${pr.branch}\\\`.\`);

// ---------- The workflow ----------

/** Lets \`size\` callers in at a time, in the order they asked. */
function slots(size: number) {
  let free = size;
  const waiting: Array<() => void> = [];
  return {
    async take() {
      if (free > 0) free--;
      else await new Promise<void>((resolve) => waiting.push(resolve));
    },
    give() {
      const next = waiting.shift();
      if (next) next();
      else free++;
    },
  };
}

export default workflow(async (w, settings: Settings) => {
  const tickets = await w.run("Read the tickets and their blockers", readTickets, settings.repo, settings.tickets);
  const external = new Set(settings.external ?? []);
  // Each ticket settles once: true when it merged (or was already closed).
  const finish = new Map<number, (merged: boolean) => void>();
  const finished = new Map<number, Promise<boolean>>();
  for (const ticket of tickets) {
    finished.set(ticket.number, new Promise((resolve) => finish.set(ticket.number, resolve)));
  }
  const building = slots(settings.atOnce ?? 3);

  const results = await w.each("Each ticket", tickets, { concurrency: 50 }, async (w, ticket) => {
    let merged = ticket.closed;
    try {
      // Still open?
      if (!merged) {
        const blockers = await Promise.all(
          ticket.blockedBy.map((blocker) => finished.get(blocker.number) ?? Promise.resolve(!blocker.open)),
        );
        // Did everything it waits on merge?
        if (blockers.every(Boolean)) {
          await building.take();
          try {
            merged = await deliver(w, settings, ticket, external.has(ticket.number));
          } finally {
            building.give();
          }
        }
      }
    } finally {
      finish.get(ticket.number)!(merged);
    }
    return { number: ticket.number, title: ticket.title, merged };
  });

  const done = results.filter((result) => result.merged);
  const left = results.filter((result) => !result.merged);
  await w.notify(
    "Tickets finished",
    left.length === 0
      ? \`All \${done.length} tickets in \${settings.repo} merged.\`
      : \`\${done.length} merged. Not merged: \${left.map((result) => \`#\${result.number} \${result.title}\`).join("; ")}. Run this again to pick up from here.\`,
    { importance: "high" },
  );
  return { merged: done.map((result) => result.number), left: left.map((result) => result.number) };
});

/** Builds and lands one ticket, asking you when it's stuck. True once it merged. */
async function deliver(w, settings: Settings, ticket: Ticket, external: boolean) {
  const state = { thread: null as string | null };
  const delivered = await w.repeat(\`Deliver #\${ticket.number}\`, { max: 3 }, async (w) => {
    let landing: Landing;
    try {
      landing = await land(w, settings, ticket, external, state);
    } catch (error) {
      landing = { merged: false, why: \`A step failed: \${String((error as Error).message).slice(0, 500)}\` };
    }
    // Merged?
    if (landing.merged) return w.done(true);
    const choice = await w.ask(\`#\${ticket.number} is stuck\`, {
      question: \`\${ticket.title}\\n\${landing.why}\`,
      options: ["try again", "skip it"],
    });
    if (choice === "skip it") return w.done(false);
  });
  // Merged in the end?
  if (delivered.done && delivered.value) {
    await w.notify(\`#\${ticket.number} merged\`, ticket.title, { importance: "low" });
    return true;
  }
  return false;
}

async function land(w, settings: Settings, ticket: Ticket, external: boolean, state: { thread: string | null }): Promise<Landing> {
  const repo = settings.repo;
  const check = settings.check ?? "Check";
  const branch = \`tickets/\${ticket.number}\`;
  let pr = await w.run(\`Look for #\${ticket.number}'s pull request\`, findPullRequest, repo, ticket.number, branch);
  // Another thread is building it?
  if (!pr && external) {
    const waited = await w.repeat("Wait for the other thread's pull request", { max: 48 }, async (w) => {
      const found = await w.run("Look again", waitForPullRequest, repo, ticket.number, branch, 14);
      if (found) return w.done(found);
    });
    pr = waited.done ? waited.value : null;
  }
  // No pull request yet?
  if (!pr) {
    const built = await w.agent(\`Build #\${ticket.number}\`, {
      ...(settings.builder ?? DEFAULT_BUILDER),
      prompt: buildPrompt(repo, ticket, branch, check),
      worktree: { base: "main", branch },
      timeout: { hours: 24 },
    });
    state.thread = built.threadId;
    pr = await w.run("Find its pull request", findPullRequest, repo, ticket.number, branch);
    // Did it forget to open one?
    if (!pr) {
      await w.agent("Ask for the pull request", {
        prompt: \`Push \\\`\${branch}\\\` and open the pull request against main with "Closes #\${ticket.number}" in the body.\`,
        thread: state.thread,
      });
      pr = await w.run("Find it again", findPullRequest, repo, ticket.number, branch);
    }
    // Still none?
    if (!pr) return { merged: false, why: "Its agent finished without opening a pull request." };
  }
  // Already merged?
  if (pr.merged) return { merged: true };

  const landed = await w.repeat(\`Land \${pr.url}\`, { max: 5 }, async (w, round) => {
    const ci = await w.repeat("Wait for CI", { max: 24 }, async (w) => {
      const status = await w.run("Check CI", checkPullRequest, repo, pr.number, check, 14);
      // Settled?
      if (status.state !== "pending") return w.done(status);
    });
    // CI never settled?
    if (!ci.done) return w.done({ merged: false, why: \`CI didn't settle within 6 hours: \${pr.url}\` });
    const status = ci.value;
    // What did CI say?
    if (status.state === "merged") return w.done({ merged: true });
    else if (status.state === "closed") return w.done({ merged: false, why: \`Someone closed \${pr.url}.\` });
    else if (status.state === "conflict") {
      await fix(w, settings, ticket, pr, state, round, "main moved on and the pull request conflicts. Merge origin/main into the branch and resolve it.");
      return;
    } else if (status.state === "red") {
      await fix(w, settings, ticket, pr, state, round, \`CI failed:\\n\${status.failed.join("\\n")}\\nRead the logs with gh run view --log-failed.\`);
      return;
    }
    const review = await w.agent(\`Review \${pr.url}\`, {
      ...(settings.reviewer ?? DEFAULT_REVIEWER),
      prompt: reviewPrompt(repo, ticket, pr),
      worktree: { base: pr.branch, branch: \`review/\${ticket.number}-\${round}\` },
      timeout: { hours: 3 },
    });
    const verdict = await w.judge("Ready to merge?", {
      input: review.text,
      question: "Does the review end with VERDICT: merge, or does it ask for fixes?",
      outcomes: ["merge", "fix"],
    });
    if (verdict === "fix") {
      await fix(w, settings, ticket, pr, state, round, \`A reviewer asked for changes:\\n\\n\${review.text}\`);
      return;
    }
    const merge = await w.run(\`Merge \${pr.url}\`, mergePullRequest, repo, pr.number);
    // Did GitHub take it?
    if (merge.ok) return w.done({ merged: true });
    await fix(w, settings, ticket, pr, state, round, \`GitHub refused the merge: \${merge.error}\`);
  });
  if (landed.done) return landed.value;
  return { merged: false, why: \`Still not mergeable after 5 rounds of fixes: \${pr.url}\` };
}

/** Sends the problem to the ticket's own agent, or to a new one on the pull request's branch. */
async function fix(w, settings: Settings, ticket: Ticket, pr: PullRequest, state: { thread: string | null }, round: number, problem: string) {
  // Do we have the agent that built it?
  if (state.thread) {
    return await w.agent("Fix it in its thread", { prompt: fixPrompt(problem, pr, true), thread: state.thread, timeout: { hours: 6 } });
  }
  return await w.agent("Fix it on the branch", {
    ...(settings.builder ?? DEFAULT_BUILDER),
    prompt: fixPrompt(problem, pr, false),
    worktree: { base: pr.branch, branch: \`fix/\${ticket.number}-\${round}\` },
    timeout: { hours: 6 },
  });
}
`,
};
