import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parseDocument } from "yaml";

import {
  dependencyClosure,
  findFileGuards,
  findFileScriptCalls,
  findRequiredCalls,
  guardedByMatchingFile,
  maskShellComments,
  repoPath,
} from "./deploy-workflow-shell.mjs";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function checkoutInputs(step) {
  if (typeof step?.uses !== "string" || !step.uses.startsWith("actions/checkout@")) return null;
  return step.with ?? {};
}

function isPullRequestHead(ref) {
  return typeof ref === "string" && ref.trim() === "${{ github.event.pull_request.head.sha }}";
}

function isDefaultBranch(ref) {
  return typeof ref === "string" && ref.trim() === "${{ github.event.repository.default_branch }}";
}

function isPullRequestJob(job, steps) {
  const condition = typeof job?.if === "string" ? job.if : "";
  return (
    /github\.event_name\s*==\s*['"]pull_request['"]/.test(condition) ||
    steps.some((step) => isPullRequestHead(checkoutInputs(step)?.ref))
  );
}

function sparseIncludes(patternText, file) {
  if (typeof patternText !== "string" || patternText.trim() === "") return true;
  const patterns = patternText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let included = false;
  for (let pattern of patterns) {
    const exclude = pattern.startsWith("!");
    if (exclude) pattern = pattern.slice(1);
    const candidate = pattern.replace(/^\/+/, "").replace(/\/$/, "");
    const matches =
      candidate === "*" ||
      candidate === file ||
      file.startsWith(`${candidate}/`) ||
      (candidate.endsWith("/**") && file.startsWith(candidate.slice(0, -3)));
    if (matches) included = !exclude;
  }
  return included;
}

export function auditDeployWorkflow(source, repoRoot = root) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("\n"));
  }
  const workflow = document.toJS();
  const jobs = workflow?.jobs;
  if (jobs === null || typeof jobs !== "object") throw new Error("Workflow has no jobs map.");
  const workflowWorkingDirectory = workflow?.defaults?.run?.["working-directory"] ?? ".";

  const problems = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    if (!isPullRequestJob(job, steps)) continue;
    const jobWorkingDirectory =
      job?.defaults?.run?.["working-directory"] ?? workflowWorkingDirectory;

    const trustedCheckouts = [];
    for (const [stepIndex, step] of steps.entries()) {
      const checkout = checkoutInputs(step);
      if (checkout) {
        const checkoutPath = repoPath(checkout.path ?? ".");
        const sameRepository =
          checkout.repository === undefined ||
          (typeof checkout.repository === "string" &&
            checkout.repository.trim() === "${{ github.repository }}");
        if (
          checkoutPath !== null &&
          checkoutPath !== "." &&
          checkoutPath !== "" &&
          sameRepository &&
          isDefaultBranch(checkout.ref)
        ) {
          trustedCheckouts.push({
            checkoutPath,
            sparseCheckout: checkout["sparse-checkout"],
            stepIndex,
          });
        }
      }

      if (typeof step?.run !== "string") continue;
      const workingDirectory = repoPath(step["working-directory"] ?? jobWorkingDirectory);
      const source = maskShellComments(step.run);
      const calls = findFileScriptCalls(source);
      const guards = findFileGuards(source, workingDirectory ?? ".");

      for (const call of calls) {
        const script = workingDirectory === null ? null : repoPath(call.file, workingDirectory);
        if (script === null) {
          problems.push(
            `${jobName}/${step.name ?? `step ${stepIndex + 1}`} has an unresolved script path ${call.file}`,
          );
          continue;
        }

        const trusted = trustedCheckouts.find(({ checkoutPath, stepIndex: checkoutIndex }) => {
          const relative = NodePath.posix.relative(checkoutPath, script);
          return (
            checkoutIndex < stepIndex &&
            relative !== ".." &&
            !relative.startsWith("../") &&
            relative !== ""
          );
        });
        if (trusted) {
          const trustedFile = NodePath.posix.relative(trusted.checkoutPath, script);
          if (!sparseIncludes(trusted.sparseCheckout, trustedFile)) {
            problems.push(
              `${jobName} trusted checkout omits directly invoked script ${trustedFile}`,
            );
            continue;
          }
          const closure = dependencyClosure(trustedFile, repoRoot);
          for (const missing of closure.failures) problems.push(`${jobName}: ${missing}`);
          for (const dependency of closure.files) {
            if (!sparseIncludes(trusted.sparseCheckout, dependency)) {
              problems.push(
                `${jobName} trusted checkout omits ${dependency}, required by ${trustedFile}`,
              );
            }
          }
          continue;
        }

        if (workingDirectory === null || !guardedByMatchingFile(guards, call.index, script)) {
          problems.push(
            `${jobName}/${step.name ?? `step ${stepIndex + 1}`} runs PR-head script ${script} without a matching file-existence guard or trusted main checkout`,
          );
        }
      }

      for (const required of findRequiredCalls(source)) {
        if (
          guards.some((guard) => required.index > guard.start && required.index < guard.blockEnd)
        ) {
          problems.push(
            `${jobName}/${step.name ?? `step ${stepIndex + 1}`} guards a required ${required.kind}; build and deploy commands must remain required`,
          );
        }
      }
    }
  }
  return problems;
}

export function assertDeployWorkflowPolicy(source, repoRoot = root) {
  const problems = auditDeployWorkflow(source, repoRoot);
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

export function currentDeployWorkflow(repoRoot = root) {
  return NodeFS.readFileSync(NodePath.join(repoRoot, ".github/workflows/deploy-cloud.yml"), "utf8");
}
