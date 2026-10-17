/**
 * The one workflow Signalbox installs in a repository so automations can run
 * steps on its GitHub Actions runners (#372). `w.run(label, { on:
 * "github-actions" }, fn, ...args)` dispatches it with the step's function,
 * its module and arguments; it runs the function in a checkout of the
 * repository, the way the host runs `w.run` in the folder, and keeps the
 * result as an artifact the engine reads when the run finishes. An agent
 * adds the file in a pull request a person merges (`workflow_dispatch` only
 * runs workflows on the default branch).
 */

export const GITHUB_ACTIONS_WORKFLOW_FILE = "signalbox-step.yml";
export const GITHUB_ACTIONS_WORKFLOW_PATH = `.github/workflows/${GITHUB_ACTIONS_WORKFLOW_FILE}`;
/** The artifact holding `result.json`: `{ ok: true, value }` or `{ ok: false, error }`. */
export const GITHUB_ACTIONS_RESULT_ARTIFACT = "signalbox-result";
/** GitHub caps a dispatch's inputs at this many characters in all. */
export const GITHUB_DISPATCH_INPUTS_LIMIT = 65_535;

/** What the workflow gets as its `payload` input. */
export interface GitHubActionsPayload {
  readonly module: string;
  readonly name: string;
  readonly args: ReadonlyArray<unknown>;
  /** Repository or environment secrets to set as environment variables for the function. */
  readonly secrets: ReadonlyArray<string>;
}

/**
 * Sets the secrets the step names, and only those, for the function's step:
 * every secret reaches this step, never the one running the function.
 */
const PICK_SECRETS = `import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const { secrets } = JSON.parse(process.env.SIGNALBOX_PAYLOAD);
const available = JSON.parse(process.env.SIGNALBOX_SECRETS || "{}");
for (const key of secrets) {
  if (!(key in available) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  const end = "SIGNALBOX_" + randomUUID();
  appendFileSync(process.env.GITHUB_ENV, key + "<<" + end + "\\n" + available[key] + "\\n" + end + "\\n");
}`;

/**
 * Calls the function and writes the result. Packages the module imports are
 * installed next to it. The payload arrives in the environment, never in the
 * script, so nothing in it runs as shell.
 */
const RUNNER = `import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = join(process.env.RUNNER_TEMP, "signalbox");
const { module, name, args } = JSON.parse(process.env.SIGNALBOX_PAYLOAD);
delete process.env.SIGNALBOX_PAYLOAD;

writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
writeFileSync(join(dir, "automation.mjs"), module);
const specifiers = [...module.matchAll(/(?:from|import)\\s*\\(?\\s*["']([^"']+)["']/g)].map((match) => match[1]);
const packages = [...new Set(specifiers
  .filter((specifier) => !/^(\\.|\\/|node:)/.test(specifier) && !builtinModules.includes(specifier))
  .map((specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")))];

let result;
try {
  if (packages.length > 0)
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...packages], { cwd: dir, stdio: "inherit" });
  const loaded = await import(pathToFileURL(join(dir, "automation.mjs")).href);
  if (typeof loaded[name] !== "function") throw new Error(name + " isn't a function in this automation.");
  const value = await loaded[name](...args);
  result = { ok: true, value: value === undefined ? null : value };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
}
writeFileSync(join(dir, "result.json"), JSON.stringify(result));
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}`;

const indent = (text: string, spaces: number) =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${" ".repeat(spaces)}${line}`))
    .join("\n");

export const GITHUB_ACTIONS_WORKFLOW = `# Signalbox runs automation steps here: w.run(label, { on: "github-actions" }, fn, ...args).
# Signalbox dispatches it; changing it may stop those steps from running.
name: Signalbox step
run-name: \${{ inputs.label }} [\${{ inputs.step }}]
on:
  workflow_dispatch:
    inputs:
      step:
        description: The Signalbox step this run is for
        required: true
      label:
        description: The step's label
        required: true
      payload:
        description: The function to run, its module and arguments, as JSON
        required: true
      environment:
        description: The environment whose secrets the function may use
        required: false
        default: ""
permissions:
  contents: read
jobs:
  run:
    name: \${{ inputs.label }}
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment }}
    timeout-minutes: 360
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: Pick the secrets
        env:
          SIGNALBOX_PAYLOAD: \${{ inputs.payload }}
          SIGNALBOX_SECRETS: \${{ toJSON(secrets) }}
        run: |
          node --input-type=module <<'SIGNALBOX_SECRETS_SCRIPT'
${indent(PICK_SECRETS, 10)}
          SIGNALBOX_SECRETS_SCRIPT
      - name: Run the function
        env:
          SIGNALBOX_PAYLOAD: \${{ inputs.payload }}
        run: |
          mkdir -p "$RUNNER_TEMP/signalbox"
          cat > "$RUNNER_TEMP/signalbox/run.mjs" <<'SIGNALBOX_RUNNER'
${indent(RUNNER, 10)}
          SIGNALBOX_RUNNER
          node "$RUNNER_TEMP/signalbox/run.mjs"
      - name: Keep the result
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: ${GITHUB_ACTIONS_RESULT_ARTIFACT}
          path: \${{ runner.temp }}/signalbox/result.json
          retention-days: 1
          if-no-files-found: ignore
`;
