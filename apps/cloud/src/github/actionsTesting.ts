// @effect-diagnostics nodeBuiltinImport:off - artifacts are zips, deflated as GitHub's are.
import * as NodeZlib from "node:zlib";

import { GITHUB_ACTIONS_RESULT_ARTIFACT } from "@signalbox/automations/githubActionsWorkflow";

/**
 * GitHub Actions for tests, plugged into `makeFakeGitHub` as `more`: Signalbox's
 * step workflow dispatched on `repository`, its runs, jobs, logs and result
 * artifact, which tests move along with `progress` and `finish`.
 */

const WEB = "https://github.test";

export interface FakeActionsJob {
  readonly name: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  readonly steps: ReadonlyArray<{
    readonly name: string;
    readonly status: "queued" | "in_progress" | "completed";
    readonly conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  }>;
  readonly log?: string;
}

interface FakeRun {
  readonly id: number;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, string>>;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  jobs: ReadonlyArray<FakeActionsJob>;
  result: unknown;
}

/** A zip of `files` the way a streaming writer makes one: deflated, sizes after the data. */
export const zipOf = (files: Readonly<Record<string, string>>) => {
  const local: Array<Buffer> = [];
  const central: Array<Buffer> = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = NodeZlib.deflateRawSync(raw);
    const crc = NodeZlib.crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0008, 6); // sizes in the data descriptor
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(raw.length, 12);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0008, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, data, descriptor);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
};

export const makeFakeActions = (repository: string) => {
  const runs: Array<FakeRun> = [];
  /** `installed: false`: the repository has no step workflow, so dispatching answers 404. */
  const settings = { installed: true };
  const base = `/repos/${repository}/actions`;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const runJson = (run: FakeRun) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: `${WEB}/${repository}/actions/runs/${run.id}`,
    display_title: `${run.inputs.label} [${run.inputs.step}]`,
  });
  const jobId = (run: FakeRun, index: number) => run.id * 100 + index;
  const runOf = (id: string | undefined) => runs.find((run) => String(run.id) === id);

  const more = (method: string, url: URL, body: Uint8Array): Response | null => {
    const path = url.pathname;
    if (!path.startsWith(base)) return null;
    const rest = path.slice(base.length);
    if (rest === "/workflows/signalbox-step.yml/dispatches" && method === "POST") {
      if (!settings.installed) return json({ message: "Not Found" }, 404);
      const request = JSON.parse(new TextDecoder().decode(body)) as {
        readonly ref: string;
        readonly inputs: Record<string, string>;
      };
      const run: FakeRun = {
        id: 1000 + runs.length,
        ref: request.ref,
        inputs: request.inputs,
        status: "queued",
        conclusion: null,
        jobs: [],
        result: undefined,
      };
      runs.push(run);
      return json({
        workflow_run_id: run.id,
        run_url: `https://api.github.test${base}/runs/${run.id}`,
        html_url: runJson(run).html_url,
      });
    }
    if (rest === "/workflows/signalbox-step.yml/runs" && method === "GET")
      return json({ workflow_runs: runs.toReversed().map(runJson) });
    const runMatch = /^\/runs\/(\d+)(\/jobs|\/artifacts|\/cancel)?$/.exec(rest);
    if (runMatch) {
      const run = runOf(runMatch[1]);
      if (!run) return json({ message: "Not Found" }, 404);
      switch (runMatch[2]) {
        case undefined:
          return json(runJson(run));
        case "/jobs":
          return json({
            jobs: run.jobs.map((job, index) => ({
              id: jobId(run, index),
              name: job.name,
              status: job.status,
              conclusion: job.conclusion,
              started_at: job.status === "queued" ? null : "2026-10-16T10:00:00Z",
              completed_at: job.status === "completed" ? "2026-10-16T10:01:00Z" : null,
              html_url: `${WEB}/${repository}/actions/runs/${run.id}/job/${jobId(run, index)}`,
              steps: job.steps.map((step, number) => ({ ...step, number: number + 1 })),
            })),
          });
        case "/artifacts":
          return json({
            artifacts:
              run.result === undefined
                ? []
                : [{ id: run.id, name: GITHUB_ACTIONS_RESULT_ARTIFACT, expired: false }],
          });
        case "/cancel":
          if (run.status === "completed") return json({ message: "Cannot cancel" }, 409);
          run.status = "completed";
          run.conclusion = "cancelled";
          return json({}, 202);
      }
    }
    const artifact = /^\/artifacts\/(\d+)\/zip$/.exec(rest);
    if (artifact) {
      const run = runOf(artifact[1]);
      if (!run || run.result === undefined) return json({ message: "Not Found" }, 404);
      return new Response(zipOf({ "result.json": JSON.stringify(run.result) }));
    }
    const log = /^\/jobs\/(\d+)\/logs$/.exec(rest);
    if (log) {
      const id = Number(log[1]);
      const run = runs.find((candidate) => Math.floor(id / 100) === candidate.id);
      const job = run?.jobs[id % 100];
      return job?.log === undefined ? json({ message: "Not Found" }, 404) : new Response(job.log);
    }
    return null;
  };

  return {
    more,
    runs,
    settings,
    /** The run is going: its jobs as they are now. */
    progress: (index: number, jobs: ReadonlyArray<FakeActionsJob>) => {
      const run = runs[index]!;
      run.status = "in_progress";
      run.jobs = jobs;
    },
    /** The run finished; `result` is the artifact's `result.json`, when it kept one. */
    finish: (
      index: number,
      conclusion: "success" | "failure",
      jobs: ReadonlyArray<FakeActionsJob>,
      result?: unknown,
    ) => {
      const run = runs[index]!;
      run.status = "completed";
      run.conclusion = conclusion;
      run.jobs = jobs;
      run.result = result;
    },
  };
};
