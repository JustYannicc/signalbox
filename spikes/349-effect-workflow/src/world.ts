/**
 * A stand-in for the Signalbox the automations talk to: threads (messages
 * only), pull requests, needs-you asks, event listeners, callback links,
 * notices and memory, in the Durable Object's SQLite. Agents and models are
 * stubs; the spike is about the durable kernel, not about them.
 *
 * Every method is synchronous SQL. Waking runs is the caller's job: methods
 * that can satisfy a wait return the deferred tokens to complete.
 */

export interface Wake {
  readonly token: string;
  readonly value: unknown;
}

export interface AskOptions {
  readonly question?: string;
  readonly options?: ReadonlyArray<string>;
  readonly multi?: boolean;
  readonly fields?: Record<string, { readonly type: string; readonly default?: unknown }>;
}

export type World = ReturnType<typeof makeWorld>;

/** `acme/app` from `https://github.com/acme/app/pull/7`. */
const repositoryOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? null;

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <A>(text: string | null): A => (text === null ? null : JSON.parse(text)) as A;

/** Top-level fields equal; an array means any of its values (today's `where`). */
const matches = (where: Record<string, unknown> | null, event: Record<string, unknown>) =>
  !where ||
  Object.entries(where).every(([field, wanted]) =>
    Array.isArray(wanted) ? wanted.includes(event[field]) : event[field] === wanted,
  );

export const makeWorld = (sql: SqlStorage, origin: () => string) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_runs (
    run_id TEXT PRIMARY KEY, automation TEXT NOT NULL, version TEXT NOT NULL, execution_id TEXT NOT NULL,
    input TEXT NOT NULL, trigger TEXT NOT NULL, restarted_from TEXT, started_at INTEGER NOT NULL, deploy TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_asks (
    ask_id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, step_key TEXT NOT NULL,
    label TEXT NOT NULL, options TEXT NOT NULL, opened_at INTEGER NOT NULL, answered_at INTEGER, answer TEXT)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_listeners (
    token TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL, events TEXT NOT NULL, filter TEXT,
    since INTEGER NOT NULL, done_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, woke TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, message TEXT NOT NULL, run_id TEXT, step_key TEXT,
    at INTEGER NOT NULL, UNIQUE (run_id, step_key))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_pull_requests (
    thread_id TEXT NOT NULL, url TEXT NOT NULL, number INTEGER NOT NULL, repository TEXT, state TEXT NOT NULL,
    branch_deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, url))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_agents (
    thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL, prompt TEXT NOT NULL, token TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_hooks (
    hook_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_notices (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, title TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_memory (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS sb_marks (
    run_id TEXT NOT NULL, mark_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, mark_key))`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS sb_deploys (deploy TEXT PRIMARY KEY, first_seen INTEGER NOT NULL)`,
  );

  const one = <A = Record<string, unknown>>(query: string, ...bindings: unknown[]) =>
    sql.exec(query, ...bindings).toArray()[0] as A | undefined;
  const all = <A = Record<string, unknown>>(query: string, ...bindings: unknown[]) =>
    sql.exec(query, ...bindings).toArray() as A[];

  /** Hands an event to every run listening for it, one waiting step per run. */
  const deliver = (event: Record<string, unknown>): Wake[] => {
    const listeners = all<{ token: string; run_id: string; events: string; filter: string | null }>(
      "SELECT token, run_id, events, filter FROM sb_listeners WHERE done_at IS NULL ORDER BY since",
    );
    const woke = new Set<string>();
    const wakes: Wake[] = [];
    for (const listener of listeners) {
      if (woke.has(listener.run_id)) continue;
      const events = parse<string[]>(listener.events);
      if (!events.includes(String(event.event)) && !events.includes("*")) continue;
      if (!matches(parse(listener.filter), event)) continue;
      woke.add(listener.run_id);
      sql.exec("UPDATE sb_listeners SET done_at = ? WHERE token = ?", Date.now(), listener.token);
      wakes.push({ token: listener.token, value: event });
    }
    sql.exec(
      "INSERT INTO sb_events (event, body, at, woke) VALUES (?, ?, ?, ?)",
      String(event.event),
      json(event),
      Date.now(),
      json([...woke]),
    );
    return wakes;
  };

  const emit = (name: string, fields: Record<string, unknown>) =>
    deliver({ event: name, id: crypto.randomUUID(), at: new Date().toISOString(), ...fields });

  return {
    deploy(deploy: string) {
      sql.exec(
        "INSERT OR IGNORE INTO sb_deploys (deploy, first_seen) VALUES (?, ?)",
        deploy,
        Date.now(),
      );
    },
    recordRun(run: {
      runId: string;
      automation: string;
      version: string;
      executionId: string;
      input: unknown;
      trigger: unknown;
      restartedFrom: string | null;
      deploy: string;
    }) {
      sql.exec(
        `INSERT OR IGNORE INTO sb_runs (run_id, automation, version, execution_id, input, trigger, restarted_from, started_at, deploy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        run.runId,
        run.automation,
        run.version,
        run.executionId,
        json(run.input),
        json(run.trigger),
        run.restartedFrom,
        Date.now(),
        run.deploy,
      );
    },
    mark(runId: string, key: string, value: unknown) {
      sql.exec(
        "INSERT OR REPLACE INTO sb_marks (run_id, mark_key, value) VALUES (?, ?, ?)",
        runId,
        key,
        json(value),
      );
    },
    openAsk(ask: {
      token: string;
      runId: string;
      key: string;
      label: string;
      options: AskOptions;
    }) {
      sql.exec(
        "INSERT OR IGNORE INTO sb_asks (token, run_id, step_key, label, options, opened_at) VALUES (?, ?, ?, ?, ?, ?)",
        ask.token,
        ask.runId,
        ask.key,
        ask.label,
        json(ask.options),
        Date.now(),
      );
      return one<{ ask_id: number }>("SELECT ask_id FROM sb_asks WHERE token = ?", ask.token)!
        .ask_id;
    },
    /** A person's answer, shaped like today's `resolveAutomationAskAnswer`. */
    answerAsk(askId: number, answer: { choice?: string; values?: Record<string, unknown> }): Wake {
      const ask = one<{ token: string; options: string; answered_at: number | null }>(
        "SELECT token, options, answered_at FROM sb_asks WHERE ask_id = ?",
        askId,
      );
      if (!ask) throw new Error(`No ask ${askId}.`);
      if (ask.answered_at !== null) throw new Error(`Ask ${askId} is already answered.`);
      const options = parse<AskOptions>(ask.options);
      const choices = options.options ?? (options.fields ? ["submit"] : ["approve", "reject"]);
      const choice = answer.choice ?? choices[0]!;
      if (!choices.includes(choice)) throw new Error(`Choose one of ${choices.join(", ")}.`);
      const values = Object.fromEntries(
        Object.entries(options.fields ?? {}).map(([name, field]) => [
          name,
          answer.values?.[name] ?? field.default ?? null,
        ]),
      );
      const value = options.fields ? { choice, values } : choice;
      sql.exec(
        "UPDATE sb_asks SET answered_at = ?, answer = ? WHERE ask_id = ?",
        Date.now(),
        json(value),
        askId,
      );
      return { token: ask.token, value };
    },
    listen(listener: {
      token: string;
      runId: string;
      key: string;
      on: string | ReadonlyArray<string>;
      where: unknown;
    }) {
      sql.exec(
        "INSERT OR IGNORE INTO sb_listeners (token, run_id, step_key, events, filter, since) VALUES (?, ?, ?, ?, ?, ?)",
        listener.token,
        listener.runId,
        listener.key,
        json(Array.isArray(listener.on) ? listener.on : [listener.on]),
        listener.where === undefined ? null : json(listener.where),
        Date.now(),
      );
    },
    unlisten(token: string) {
      sql.exec(
        "UPDATE sb_listeners SET done_at = ? WHERE token = ? AND done_at IS NULL",
        Date.now(),
        token,
      );
    },
    emit,
    startAgent(agent: {
      token: string;
      runId: string;
      key: string;
      prompt: string;
      thread?: string;
    }) {
      const threadId =
        agent.thread ?? `thread-${agent.runId.slice(0, 8)}-${agent.key.replace(/[^a-z0-9]/gi, "")}`;
      sql.exec(
        `INSERT INTO sb_agents (thread_id, run_id, step_key, prompt, token, started_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET run_id = excluded.run_id, step_key = excluded.step_key,
           prompt = excluded.prompt, token = excluded.token, started_at = excluded.started_at, finished_at = NULL`,
        threadId,
        agent.runId,
        agent.key,
        agent.prompt,
        agent.token,
        Date.now(),
      );
      return { threadId };
    },
    /** Stands in for the thread's turn ending: completes the `w.agent` step waiting on it. */
    finishTurn(
      threadId: string,
      text: string,
      pullRequest: { number: number; url: string } | null,
    ): Wake {
      const agent = one<{ token: string; finished_at: number | null }>(
        "SELECT token, finished_at FROM sb_agents WHERE thread_id = ?",
        threadId,
      );
      if (!agent || agent.finished_at !== null)
        throw new Error(`No agent turn running in ${threadId}.`);
      sql.exec("UPDATE sb_agents SET finished_at = ? WHERE thread_id = ?", Date.now(), threadId);
      if (pullRequest) {
        sql.exec(
          "INSERT OR IGNORE INTO sb_pull_requests (thread_id, url, number, repository, state) VALUES (?, ?, ?, ?, 'open')",
          threadId,
          pullRequest.url,
          pullRequest.number,
          repositoryOf(pullRequest.url),
        );
      }
      return {
        token: agent.token,
        value: { text, threadId, branch: null, worktreePath: null, pullRequest },
      };
    },
    createHook(runId: string, key: string) {
      const hookId = `callback_${runId.slice(0, 8)}_${key.replace(/[^a-z0-9]/gi, "")}`;
      sql.exec(
        "INSERT OR IGNORE INTO sb_hooks (hook_id, run_id, created_at) VALUES (?, ?, ?)",
        hookId,
        runId,
        Date.now(),
      );
      const path = `/hooks/${hookId}`;
      return { hookId, path, url: `${origin()}${path}` };
    },
    hookCalled(hookId: string, method: string, body: unknown): Wake[] {
      if (!one("SELECT hook_id FROM sb_hooks WHERE hook_id = ?", hookId))
        throw new Error(`No callback link ${hookId}.`);
      return emit("hook.called", { hookId, method, body, query: {} });
    },
    /** One-shot steps: `call`, `notify`, `judge`, `llm`, `http`, `recall`, `remember`. */
    runStep(
      runId: string,
      key: string,
      verb: string,
      label: string,
      args: ReadonlyArray<unknown>,
    ): { value: unknown; wakes: Wake[] } {
      const [first, second] = args as [unknown, unknown];
      switch (verb) {
        case "call":
          return call(runId, key, String(first), (second ?? {}) as Record<string, unknown>);
        case "notify":
          sql.exec(
            "INSERT INTO sb_notices (run_id, title, message, at) VALUES (?, ?, ?, ?)",
            runId,
            label,
            String(first),
            Date.now(),
          );
          return { value: null, wakes: [] };
        case "judge": {
          // Stub model: the first outcome unless the input says otherwise.
          const { outcomes, input } = first as { outcomes: string[]; input: unknown };
          const text = JSON.stringify(input ?? "").toLowerCase();
          const negative = /could ?n[o']t|not reproduc|no repro|ignore/.test(text);
          return { value: negative ? outcomes[outcomes.length - 1] : outcomes[0], wakes: [] };
        }
        case "llm":
          return { value: `(stub model) ${label}`, wakes: [] };
        case "recall":
          return {
            value: parse(
              one<{ value: string }>("SELECT value FROM sb_memory WHERE key = ?", String(first))
                ?.value ?? null,
            ),
            wakes: [],
          };
        case "remember":
          sql.exec(
            "INSERT OR REPLACE INTO sb_memory (key, value) VALUES (?, ?)",
            String(first),
            json(second),
          );
          return { value: null, wakes: [] };
        default:
          throw new Error(`w.${verb} isn't part of the spike.`);
      }
    },
    status() {
      return {
        deploys: all("SELECT deploy, first_seen FROM sb_deploys ORDER BY first_seen"),
        runs: all(
          "SELECT run_id, automation, substr(version, 1, 12) AS version, execution_id, restarted_from, started_at, deploy FROM sb_runs ORDER BY started_at",
        ),
        asks: all(
          "SELECT ask_id, run_id, step_key, label, opened_at, answered_at, answer FROM sb_asks ORDER BY ask_id",
        ),
        listeners: all(
          "SELECT run_id, step_key, events, filter, since, done_at FROM sb_listeners ORDER BY since",
        ),
        events: all("SELECT seq, event, at, woke FROM sb_events ORDER BY seq"),
        messages: all(
          "SELECT seq, thread_id, message, run_id, step_key, at FROM sb_messages ORDER BY seq",
        ),
        pullRequests: all("SELECT * FROM sb_pull_requests"),
        agents: all("SELECT thread_id, run_id, step_key, started_at, finished_at FROM sb_agents"),
        notices: all("SELECT * FROM sb_notices ORDER BY seq"),
        marks: all("SELECT * FROM sb_marks ORDER BY run_id, mark_key"),
      };
    },
  };

  /** `signalbox.*` tools the built-ins call, against this world. */
  function call(
    runId: string,
    key: string,
    operation: string,
    args: Record<string, unknown>,
  ): { value: unknown; wakes: Wake[] } {
    const threadId = String(args.threadId ?? "");
    switch (operation) {
      case "signalbox.t3_thread_send":
        // The step key is the request id, so a re-executed step doesn't send twice.
        sql.exec(
          "INSERT OR IGNORE INTO sb_messages (thread_id, message, run_id, step_key, at) VALUES (?, ?, ?, ?, ?)",
          threadId,
          String(args.message),
          runId,
          key,
          Date.now(),
        );
        return { value: { queued: true }, wakes: [] };
      case "signalbox.link_pull_request": {
        const url = String(args.url);
        const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
        sql.exec(
          "INSERT OR IGNORE INTO sb_pull_requests (thread_id, url, number, repository, state) VALUES (?, ?, ?, ?, 'open')",
          threadId,
          url,
          number,
          repositoryOf(url),
        );
        return { value: { linked: true }, wakes: [] };
      }
      case "signalbox.list_thread_pull_requests":
        return {
          value: {
            pullRequests: all(
              "SELECT number, url, state FROM sb_pull_requests WHERE thread_id = ?",
              threadId,
            ),
          },
          wakes: [],
        };
      case "signalbox.pull_request_action": {
        const pr = one<{ number: number; state: string; repository: string | null }>(
          "SELECT number, state, repository FROM sb_pull_requests WHERE thread_id = ? AND url = ?",
          threadId,
          String(args.url),
        );
        if (!pr) throw new Error(`${String(args.url)} isn't linked to ${threadId}.`);
        if (args.action === "delete-branch") {
          sql.exec(
            "UPDATE sb_pull_requests SET branch_deleted = 1 WHERE thread_id = ? AND url = ?",
            threadId,
            String(args.url),
          );
          return { value: { state: pr.state }, wakes: [] };
        }
        if (args.action !== "merge") throw new Error(`Unknown action ${String(args.action)}.`);
        // A re-run merge that already landed is done, like the real tool.
        if (pr.state === "merged") return { value: { state: "merged" }, wakes: [] };
        sql.exec(
          "UPDATE sb_pull_requests SET state = 'merged' WHERE thread_id = ? AND url = ?",
          threadId,
          String(args.url),
        );
        const wakes = emit("pr.merged", {
          threadId,
          number: pr.number,
          url: String(args.url),
          repository: pr.repository,
        });
        return { value: { state: "merged" }, wakes };
      }
      default:
        throw new Error(`${operation} isn't connected in the spike.`);
    }
  }
};
