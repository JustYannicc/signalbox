import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The automation tables and how older copies of them are brought up to date.
 *
 * Fork tables create themselves instead of taking a migration number, because
 * the migration runner only applies ids above the latest recorded one and a
 * fork number would later shadow upstream's (see AGENTS.md). So every change
 * here has to work against whatever shape an existing database already has.
 */

const TABLES = [
  /** Names are unique per project: two projects can each have a "Weekly report". */
  `CREATE TABLE IF NOT EXISTS signalbox_automations (
    automation_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL,
    version INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    defaults_json TEXT NOT NULL,
    triggers_json TEXT NOT NULL,
    webhook_token TEXT NOT NULL,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    timeout_ms INTEGER,
    overlap TEXT,
    draft_version INTEGER,
    intent TEXT,
    webhook_secret_set INTEGER NOT NULL DEFAULT 0,
    builtin_slug TEXT,
    live_since TEXT,
    UNIQUE (project_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS signalbox_automation_versions (
    automation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source TEXT NOT NULL,
    script TEXT NOT NULL,
    run_module TEXT,
    graph_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    meta_json TEXT,
    defaults_json TEXT,
    approved_by TEXT,
    PRIMARY KEY (automation_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS signalbox_automation_runs (
    run_id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    error TEXT,
    marks_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    title TEXT,
    logs_json TEXT,
    trigger_json TEXT,
    parent_run_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    deadline_at TEXT,
    error_detail_json TEXT,
    retry_of_run_id TEXT,
    replay_seed TEXT,
    replay_started_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS signalbox_automation_steps (
    run_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    node_id TEXT NOT NULL,
    verb TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    thread_id TEXT,
    wake_at TEXT,
    event TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    error_detail_json TEXT,
    agent_run_id TEXT,
    external_json TEXT,
    poll_at TEXT,
    PRIMARY KEY (run_id, step_key)
  )`,
  `CREATE TABLE IF NOT EXISTS signalbox_automation_memory (
    automation_id TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (automation_id, memory_key)
  )`,
  /** Webhook delivery ids seen recently, so a sender's retry doesn't start a second run. */
  `CREATE TABLE IF NOT EXISTS signalbox_automation_webhook_keys (
    automation_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (automation_id, request_key)
  )`,
  /** Recent webhook requests that didn't start a run; accepted ones are runs. */
  `CREATE TABLE IF NOT EXISTS signalbox_automation_webhook_rejections (
    automation_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    method TEXT NOT NULL,
    outcome TEXT NOT NULL,
    body_bytes INTEGER NOT NULL,
    relayed INTEGER NOT NULL
  )`,
  /**
   * What a run is bound to beyond its row: the thread it's attached to, and
   * the run it continues after `w.restart`. Only runs with either get a row.
   */
  /**
   * Outcomes a durable backend's instance hasn't taken yet (runner/): a step
   * settled from outside is recorded before its instance is told, and stays
   * until the backend takes it, so an outage never strands a waiting run.
   */
  `CREATE TABLE IF NOT EXISTS signalbox_automation_instance_events (
    run_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step_key)
  )`,
  `CREATE TABLE IF NOT EXISTS signalbox_automation_run_links (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT,
    attach_key TEXT,
    label TEXT,
    restart_of_run_id TEXT,
    lineage_id TEXT NOT NULL,
    started_at TEXT NOT NULL
  )`,
  /**
   * Events a running run's `w.waitFor({ on })` steps listen for, kept from
   * the run's start so one arriving between steps isn't lost. Each event goes
   * to one step; finished runs' rows are deleted.
   */
  `CREATE TABLE IF NOT EXISTS signalbox_automation_run_inbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    consumed_by TEXT,
    UNIQUE (run_id, event_id)
  )`,
  /**
   * Callback links runs made with `w.hook`: a request to one with its token
   * becomes a `hook.called` event while the run that made it is running.
   */
  `CREATE TABLE IF NOT EXISTS signalbox_automation_callbacks (
    hook_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  /**
   * Watched sources (sources/sourceWatches.ts): one row per thing read, however
   * many automations and runs watch it, with its last read so a restart picks
   * up where it left off instead of replaying.
   */
  `CREATE TABLE IF NOT EXISTS signalbox_automation_sources (
    source_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    watch_json TEXT NOT NULL,
    snapshot_json TEXT,
    interval_ms INTEGER NOT NULL,
    next_check_at TEXT NOT NULL,
    last_checked_at TEXT,
    last_read_at TEXT,
    last_changed_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    paused_at TEXT,
    paused_watchers_json TEXT,
    wanted_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

/**
 * Columns added after a table shipped, as `[table, column, type]`. CREATE TABLE
 * IF NOT EXISTS leaves an existing table alone, so a new column goes in both
 * its CREATE statement (fresh databases) and here (existing ones). A
 * constraint change can't be added this way; it needs a table rebuild.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["signalbox_automations", "webhook_secret_set", "INTEGER NOT NULL DEFAULT 0"],
  ["signalbox_automations", "builtin_slug", "TEXT"],
  ["signalbox_automation_versions", "approved_by", "TEXT"],
  ["signalbox_automation_sources", "paused_watchers_json", "TEXT"],
  ["signalbox_automation_sources", "last_read_at", "TEXT"],
  ["signalbox_automations", "live_since", "TEXT"],
  ["signalbox_automation_versions", "worker_module", "TEXT"],
  ["signalbox_automation_runs", "instance_at", "TEXT"],
  ["signalbox_automation_steps", "external_json", "TEXT"],
  ["signalbox_automation_steps", "poll_at", "TEXT"],
];

/** Indexes go last: some cover added columns. */
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS signalbox_automation_runs_by_automation
    ON signalbox_automation_runs (automation_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_runs_by_status ON signalbox_automation_runs (status)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_runs_by_parent
    ON signalbox_automation_runs (parent_run_id)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_steps_by_status
    ON signalbox_automation_steps (status, verb)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_steps_by_poll
    ON signalbox_automation_steps (status, poll_at)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_steps_by_thread
    ON signalbox_automation_steps (thread_id)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_steps_by_event
    ON signalbox_automation_steps (event)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automations_by_webhook
    ON signalbox_automations (webhook_token)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_webhook_rejections_by_automation
    ON signalbox_automation_webhook_rejections (automation_id, received_at)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_run_links_by_thread
    ON signalbox_automation_run_links (thread_id, attach_key)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_run_links_by_lineage
    ON signalbox_automation_run_links (lineage_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_run_inbox_by_run
    ON signalbox_automation_run_inbox (run_id, consumed_by)`,
  `CREATE INDEX IF NOT EXISTS signalbox_automation_callbacks_by_run
    ON signalbox_automation_callbacks (run_id)`,
];

/** Creates the tables, or brings existing ones up to the current shape. Safe to run every start. */
export const ensureAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of TABLES) yield* sql.unsafe(statement);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((existing) => existing.name === column)) {
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  for (const statement of INDEXES) yield* sql.unsafe(statement);
});
