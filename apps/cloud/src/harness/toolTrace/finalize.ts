import type {
  HarnessExpectedToolCall,
  HarnessToolHookReceipt,
  HarnessToolTraceResult,
  HarnessToolTraceGap,
  HarnessChildProcessEvidence,
  HarnessToolCallVerdict,
  MutableChildProcess,
  ShellCandidate,
  HarnessToolTraceState,
} from "./types.ts";
import {
  pairHooks,
  findWindowChildren,
  expectedMatchesPre,
  expectedMatchesHook,
  sameHookIdentity,
  validHookKey,
  callbackIdMismatch,
  fieldEquals,
  duplicateExpectedKeys,
  expectedKey,
  unique,
} from "./matching.ts";
import { findShellCandidates } from "./shellCandidates.ts";

export function finalizeHarnessToolTrace(
  state: HarnessToolTraceState,
  expectedCalls: readonly HarnessExpectedToolCall[],
): HarnessToolTraceResult {
  const { hooks, children, spawnObservations, unattachedReceipts } = state;
  const gaps: HarnessToolTraceGap[] = [];
  const preHooks = hooks.filter((hook) => hook.event === "PreToolUse");
  const terminalHooks = hooks.filter((hook) => hook.event !== "PreToolUse");
  const pairings = pairHooks(preHooks, terminalHooks, gaps);
  const shellCandidates = findShellCandidates(
    preHooks,
    pairings,
    [...children.values()],
    state.pathMapping,
  );
  const childCandidates = new Map<string, ShellCandidate[]>();
  for (const candidate of shellCandidates) {
    for (const child of candidate.children) {
      const list = childCandidates.get(child.childId) ?? [];
      list.push(candidate);
      childCandidates.set(child.childId, list);
    }
  }
  const childOwners = new Map<string, ShellCandidate>();
  for (const candidate of shellCandidates) {
    if (candidate.children.length !== 1) continue;
    const child = candidate.children[0]!;
    if (spawnObservations.get(child.childId)?.length !== 1) continue;
    if (childCandidates.get(child.childId)?.length === 1) childOwners.set(child.childId, candidate);
  }

  const duplicateExpected = duplicateExpectedKeys(expectedCalls);
  const verdicts = expectedCalls.map((expected): HarnessToolCallVerdict => {
    const reasons: string[] = [];
    const matchingPres = preHooks.filter((hook) => expectedMatchesPre(expected, hook));
    const pre = matchingPres.length === 1 ? matchingPres[0] : undefined;
    const pairing = pre === undefined ? undefined : pairings.get(pre.sequence);
    const terminal = pairing?.terminal;
    const terminalCandidates =
      pre === undefined ? [] : terminalHooks.filter((hook) => sameHookIdentity(pre, hook));
    const candidateChildren =
      pre === undefined ? [] : findWindowChildren(pre, terminal, [...children.values()]);
    const candidateChildIds = candidateChildren.map((child) => child.childId);
    const associatedChildren = candidateChildren.filter(
      (child) => childOwners.get(child.childId)?.pre.sequence === pre?.sequence,
    );

    if (duplicateExpected.has(expectedKey(expected))) reasons.push("duplicate-expected-call-id");
    if (expected.id.length === 0) reasons.push("expected-tool-use-id-missing");
    if (expected.name.length === 0) reasons.push("expected-tool-name-missing");
    if (matchingPres.length === 0) reasons.push("missing-pre-hook");
    else if (matchingPres.length > 1) reasons.push("duplicate-or-ambiguous-pre-hook");
    if (pre !== undefined) {
      if (!fieldEquals(pre.fields.hook_event_name, "PreToolUse"))
        reasons.push("pre-hook-event-name-mismatch");
      if (!fieldEquals(pre.fields.tool_name, expected.name)) reasons.push("tool-name-mismatch");
      if (callbackIdMismatch(pre)) reasons.push("callback-tool-use-id-mismatch");
      if (pairing === undefined || terminal === undefined) reasons.push("missing-terminal-hook");
      else {
        reasons.push(...pairing.reasons);
        if (!fieldEquals(terminal.fields.hook_event_name, terminal.event))
          reasons.push("terminal-hook-event-name-mismatch");
        if (!fieldEquals(terminal.fields.tool_name, expected.name))
          reasons.push("terminal-tool-name-mismatch");
        if (callbackIdMismatch(terminal)) reasons.push("terminal-callback-tool-use-id-mismatch");
        if (terminalCandidates.length > 1) reasons.push("duplicate-terminal-hook");
      }
    }

    const hooksValid = pre !== undefined && terminal !== undefined && reasons.length === 0;
    if (!hooksValid) {
      return {
        kind: "gap",
        expected,
        reasons: unique(reasons),
        preCandidates: matchingPres,
        terminalCandidates,
        candidateChildIds,
        children: associatedChildren.map(toEvidence),
      };
    }

    if (expected.name === "Bash") {
      const candidate = shellCandidates.find((row) => row.pre.sequence === pre.sequence);
      if (candidate === undefined) {
        return gapVerdict(
          expected,
          "bash-command-or-cwd-unavailable",
          pre,
          terminal,
          candidateChildIds,
        );
      }
      if (candidate.children.length === 0) {
        return gapVerdict(
          expected,
          candidate.reason ?? "no-exact-shell-child-match",
          pre,
          terminal,
          candidateChildIds,
        );
      }
      if (candidate.children.length > 1) {
        return gapVerdict(
          expected,
          "ambiguous-multiple-shell-children",
          pre,
          terminal,
          candidateChildIds,
        );
      }
      const child = candidate.children[0]!;
      if (spawnObservations.get(child.childId)?.length !== 1) {
        return gapVerdict(expected, "duplicate-child-id", pre, terminal, candidateChildIds);
      }
      if (childOwners.get(child.childId)?.pre.sequence !== pre.sequence) {
        return gapVerdict(
          expected,
          "ambiguous-overlapping-tool-window",
          pre,
          terminal,
          candidateChildIds,
        );
      }
      if (child.closeReceipts.length !== 1) {
        const reason =
          child.closeReceipts.length === 0
            ? "child-lifecycle-incomplete"
            : "duplicate-child-close-receipt";
        gaps.push({
          scope: "child",
          reason,
          processKey: child.processKey,
          childId: child.childId,
        });
        return {
          kind: "gap",
          expected,
          reasons: [reason],
          preCandidates: [pre],
          terminalCandidates: [terminal],
          candidateChildIds,
          children: [toEvidence(child)],
        };
      }
      const provenance = candidate.provenance.find((row) => row.childId === child.childId)?.value;
      if (provenance === undefined) {
        return gapVerdict(
          expected,
          "missing-shell-join-provenance",
          pre,
          terminal,
          candidateChildIds,
        );
      }
      return {
        kind: "joined",
        expected,
        hooks: { pre, terminal },
        children: [toEvidence(child)],
        provenance,
      };
    }

    const unownedChildren = candidateChildren.filter(
      (child) => childOwners.has(child.childId) === false,
    );
    if (unownedChildren.length > 0) {
      return gapVerdict(expected, "unattributed-child-in-window", pre, terminal, candidateChildIds);
    }
    return { kind: "no-child", expected, hooks: { pre, terminal }, children: [] };
  });

  const associatedChildIds = new Set(childOwners.keys());
  const ownedChildIds = new Set(childOwners.keys());
  for (const child of children.values()) {
    if (child.childId.length === 0) {
      gaps.push({
        scope: "child",
        reason: "missing-child-id",
        processKey: child.processKey,
        childId: child.childId,
      });
    } else if (!ownedChildIds.has(child.childId)) {
      const overlapping = preHooks.filter((pre) => {
        const terminal = pairings.get(pre.sequence)?.terminal;
        return findWindowChildren(pre, terminal, [child]).length > 0;
      });
      gaps.push({
        scope: "child",
        reason: overlapping.length > 0 ? "unattributed-or-ambiguous-child" : "orphan-child",
        processKey: child.processKey,
        childId: child.childId,
        ...(overlapping.length === 0
          ? {}
          : { candidateHookSequences: overlapping.map((hook) => hook.sequence) }),
      });
    }
  }
  for (const [childId, observations] of spawnObservations) {
    for (const duplicate of observations.slice(1)) {
      gaps.push({
        scope: "child",
        reason: "duplicate-child-id",
        processKey: duplicate.processKey,
        childId,
      });
    }
  }
  for (const receipt of unattachedReceipts) {
    gaps.push({
      scope: "child",
      reason: `unattached-child-${receipt.kind}-receipt`,
      childId: receipt.childId,
    });
  }

  const unexpectedHookEvents = hooks.filter(
    (hook) => !expectedCalls.some((expected) => expectedMatchesHook(expected, hook)),
  );
  for (const hook of unexpectedHookEvents) {
    gaps.push({
      scope: "hook",
      reason: "unexpected-hook-event",
      processKey: hook.processKey,
      hookSequence: hook.sequence,
    });
  }
  const duplicateHookEvents = duplicateHookCount(hooks);
  const lifecycleIncomplete = [...children.values()].filter(
    (child) => ownedChildIds.has(child.childId) && child.closeReceipts.length !== 1,
  ).length;
  const joined = verdicts.filter((verdict) => verdict.kind === "joined").length;
  const noChild = verdicts.filter((verdict) => verdict.kind === "no-child").length;
  const callGaps = verdicts.length - joined - noChild;
  const completePairs = expectedCalls.filter((expected) => {
    if (duplicateExpected.has(expectedKey(expected))) return false;
    const matching = preHooks.filter((hook) => expectedMatchesPre(expected, hook));
    if (matching.length !== 1) return false;
    const pre = matching[0]!;
    const terminal = pairings.get(pre.sequence)?.terminal;
    return (
      terminal !== undefined &&
      (pairings.get(pre.sequence)?.reasons.length ?? 0) === 0 &&
      !callbackIdMismatch(pre) &&
      !callbackIdMismatch(terminal) &&
      fieldEquals(pre.fields.hook_event_name, "PreToolUse") &&
      fieldEquals(terminal.fields.hook_event_name, terminal.event) &&
      fieldEquals(pre.fields.tool_name, expected.name) &&
      fieldEquals(terminal.fields.tool_name, expected.name)
    );
  }).length;

  return {
    verdicts,
    hooks: [...hooks],
    childProcesses: new Map([...children].map(([id, child]) => [id, toEvidence(child)])),
    childSpawnObservations: new Map(
      [...spawnObservations].map(([id, observations]) => [id, [...observations]]),
    ),
    unattachedChildReceipts: [...unattachedReceipts],
    gaps,
    coverage: {
      toolCalls: { denominator: expectedCalls.length, joined, noChild, gaps: callGaps },
      hookPairs: {
        denominator: expectedCalls.length,
        complete: completePairs,
        gaps: expectedCalls.length - completePairs,
        unexpectedEvents: unexpectedHookEvents.length,
        duplicateEvents: duplicateHookEvents,
      },
      childProcesses: {
        denominator: children.size,
        associated: associatedChildIds.size,
        orphaned: [...children.keys()].filter((id) => !ownedChildIds.has(id)).length,
        lifecycleIncomplete,
      },
    },
  };
}

function duplicateHookCount(hooks: readonly HarnessToolHookReceipt[]): number {
  const counts = new Map<string, { pre: number; terminal: number }>();
  for (const hook of hooks) {
    const key = validHookKey(hook);
    if (key === undefined) continue;
    const count = counts.get(key) ?? { pre: 0, terminal: 0 };
    if (hook.event === "PreToolUse") count.pre++;
    else count.terminal++;
    counts.set(key, count);
  }
  return [...counts.values()].reduce(
    (total, count) => total + Math.max(0, count.pre - 1) + Math.max(0, count.terminal - 1),
    0,
  );
}

function gapVerdict(
  expected: HarnessExpectedToolCall,
  reason: string,
  pre: HarnessToolHookReceipt,
  terminal: HarnessToolHookReceipt,
  candidateChildIds: readonly string[],
): HarnessToolCallVerdict {
  return {
    kind: "gap",
    expected,
    reasons: [reason],
    preCandidates: [pre],
    terminalCandidates: [terminal],
    candidateChildIds,
    children: [],
  };
}

function toEvidence(child: MutableChildProcess): HarnessChildProcessEvidence {
  return {
    ...child,
    closeReceipts: [...child.closeReceipts],
    traceReceipts: [...child.traceReceipts],
  };
}
