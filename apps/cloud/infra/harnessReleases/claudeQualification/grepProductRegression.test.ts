import { expect, it } from "vite-plus/test";
import { assertClaudeKernelGrep } from "./grepProductRegression.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../../src/kernel/KernelRipgrepProgram.ts";

const file = "/workspace/claude-qualification.txt";
const workRoute = "/claude/baseline/turn/1/dispatch";
const runId = "grep-product-regression";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function evidence(rgHash: string = KERNEL_RIPGREP_ARTIFACT.sha256) {
  const first = { tools: [{ name: "Grep", input_schema: { type: "object" } }] };
  const result = { type: "tool_result", tool_use_id: "grep-5", content: `${file}:1:after` };
  const request = {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "grep-5",
            name: "Grep",
            input: { pattern: "after", path: file, output_mode: "content" },
          },
        ],
      },
      { role: "user", content: [result] },
    ],
  };
  const producerEvents = ["entered", "terminal"].map((milestone) => ({
    schema: "sb1070/producer/v1",
    runId,
    identity: "command:default",
    entrypoint: "default",
    tag: "actual-command-run",
    producerClass: "dynamic-worker",
    route: { method: "POST", path: workRoute },
    invocationId: "kernel-rg-1",
    workerId: "worker-rg-1",
    milestone,
  }));
  const kernelInvocations = [
    {
      runId,
      invocationId: "kernel-rg-1",
      toolUseId: "grep-5",
      toolName: "Grep",
      executable: "/bin/rg",
      argv: ["rg", "--hidden", "--json", "after", file],
      wasmReferences: [rgHash],
      route: { method: "POST", path: workRoute },
      exit: { exitCode: 0, signal: 0, coreDumped: false },
    },
  ];
  const input = () => ({
    runId,
    requests: [encode(first), encode(request)],
    producerEvents,
    kernelInvocations,
    workRoute,
  });
  return { first, result, request, producerEvents, kernelInvocations, input };
}

it("requires advertised Grep, a successful matching result and a joined kernel rg invocation", () => {
  const f = evidence();
  expect(assertClaudeKernelGrep(f.input())).toEqual({
    toolUseId: "grep-5",
    resultText: `${file}:1:after`,
    kernelInvocationId: "kernel-rg-1",
  });
});

it("accepts the real kernel's relative file operand within the search cwd", () => {
  const f = evidence();
  Object.assign(f.kernelInvocations[0]!, {
    cwd: "/workspace",
    argv: ["rg", "after", "claude-qualification.txt"],
  });
  expect(assertClaudeKernelGrep(f.input()).toolUseId).toBe("grep-5");
});

it("rejects command evidence from another run", () => {
  const f = evidence();
  f.kernelInvocations[0]!.runId = "another-run";
  expect(() => assertClaudeKernelGrep(f.input())).toThrow(
    "CLAUDE_GREP_PRODUCT_KERNEL_SEARCH_MISSING",
  );
});

it("rejects the retained failure even if a peer offers the missing tool anyway", () => {
  const f = evidence();
  f.first.tools = [];
  f.result.content = "No such tool available: Grep";
  expect(() => assertClaudeKernelGrep(f.input())).toThrow("CLAUDE_GREP_PRODUCT_NOT_ADVERTISED");
});

it("rejects a tool error even when its message mentions the expected path and match", () => {
  const f = evidence();
  Object.assign(f.result, { is_error: true });
  expect(() => assertClaudeKernelGrep(f.input())).toThrow("CLAUDE_GREP_PRODUCT_RESULT_FAILED");
});

it("does not mistake default filenames output for matching content", () => {
  const f = evidence();
  f.result.content = `Found 1 file\n${file}`;
  expect(() => assertClaudeKernelGrep(f.input())).toThrow("CLAUDE_GREP_PRODUCT_MATCH_TEXT_MISSING");
});

it("rejects a plausible result without actual kernel rg completion", () => {
  const f = evidence();
  f.producerEvents.pop();
  expect(() => assertClaudeKernelGrep(f.input())).toThrow(
    "CLAUDE_GREP_PRODUCT_KERNEL_RG_NOT_JOINED",
  );
});

it("rejects a version check as proof of a real search", () => {
  const f = evidence();
  f.kernelInvocations[0]!.argv = ["rg", "--version"];
  expect(() => assertClaudeKernelGrep(f.input())).toThrow(
    "CLAUDE_GREP_PRODUCT_KERNEL_SEARCH_MISSING",
  );
});

it("rejects a different executable artifact even when the result looks right", () => {
  const f = evidence("0".repeat(64));
  expect(() => assertClaudeKernelGrep(f.input())).toThrow(
    "CLAUDE_GREP_PRODUCT_KERNEL_SEARCH_MISSING",
  );
});

it("rejects a matching search performed by another tool call", () => {
  const f = evidence();
  f.kernelInvocations[0]!.toolUseId = "another-tool";
  expect(() => assertClaudeKernelGrep(f.input())).toThrow(
    "CLAUDE_GREP_PRODUCT_KERNEL_SEARCH_MISSING",
  );
});

it("rejects result prose that merely mentions the file and pattern", () => {
  const f = evidence();
  f.result.content = `No matches for after in ${file}`;
  expect(() => assertClaudeKernelGrep(f.input())).toThrow("CLAUDE_GREP_PRODUCT_MATCH_TEXT_MISSING");
});

it("rejects ambiguous command ownership for one Grep result", () => {
  const f = evidence();
  f.kernelInvocations.push({ ...f.kernelInvocations[0]!, invocationId: "another-rg" });
  expect(() => assertClaudeKernelGrep(f.input())).toThrow(
    "CLAUDE_GREP_PRODUCT_KERNEL_SEARCH_MISSING",
  );
});
