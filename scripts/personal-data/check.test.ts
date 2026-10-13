// @effect-diagnostics nodeBuiltinImport:off - Builds throwaway git repos to scan.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { forkAddedLines, parseAllowlist, parseDenylist, scanLines } from "./check.ts";

// Assembled at runtime so this file never contains an address the guard itself would flag.
const at = "@";
const ALLOWLIST = parseAllowlist(["example.com", "*.example", `a${at}b.co`].join("\n"));

const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", `user.email=test${at}example.com`, ...args],
    { cwd, encoding: "utf8" },
  );
}

function write(cwd: string, file: string, contents: string) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, file), contents);
}

/** An upstream commit on `upstream`, then fork work on `main` on top of it. */
function forkRepo(upstreamFiles: Record<string, string>, forkFiles: Record<string, string>) {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "personal-data-"));
  repos.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  for (const [file, contents] of Object.entries(upstreamFiles)) write(cwd, file, contents);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "upstream");
  git(cwd, "branch", "upstream");
  for (const [file, contents] of Object.entries(forkFiles)) write(cwd, file, contents);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "fork");
  return cwd;
}

describe("forkAddedLines", () => {
  it("scans only what the fork adds, so upstream content never trips it", () => {
    const cwd = forkRepo(
      { "README.md": `Maintainer: jo${at}upstream-corp.io\n` },
      {
        "README.md": `Maintainer: jo${at}upstream-corp.io\nFork owner: sam${at}realmail.ch\n`,
        "src/fixture.ts": `export const user = "lee${at}people.example";\n`,
      },
    );

    const findings = scanLines(forkAddedLines(cwd, "upstream"), ALLOWLIST, []);

    expect(findings).toEqual([
      { kind: "email", file: "README.md", line: 2, domain: "realmail.ch" },
    ]);
  });

  it("follows upstream merges: content upstream adds later is not the fork's", () => {
    const cwd = forkRepo({ "a.txt": "one\n" }, { "fork.txt": "ours\n" });
    git(cwd, "checkout", "-q", "upstream");
    write(cwd, "a.txt", `one\nnew contributor ${"kim"}${at}contributor.dev\n`);
    git(cwd, "commit", "-q", "-am", "upstream moves on");
    git(cwd, "checkout", "-q", "main");
    git(cwd, "merge", "-q", "--no-edit", "upstream");

    expect(scanLines(forkAddedLines(cwd, "upstream"), ALLOWLIST, [])).toEqual([]);
  });

  it("fails loudly when the upstream ref is missing instead of passing", () => {
    const cwd = forkRepo({ "a.txt": "one\n" }, { "b.txt": "two\n" });
    expect(() => forkAddedLines(cwd, "no-such-ref")).toThrow();
  });
});

describe("scanLines", () => {
  const line = (text: string) => [{ file: "f.ts", line: 1, text }];

  it("accepts allowlisted domains, subdomains, suffixes, and exact addresses", () => {
    const text = [
      `x${at}example.com`,
      `x${at}box.example.com`,
      `x${at}northwind.example`,
      `a${at}b.co`,
      "icon@2x.png",
      "npx signalbox-cli@1.2.3",
    ].join(" ");
    expect(scanLines(line(text), ALLOWLIST, [])).toEqual([]);
  });

  it("flags other addresses at the same short domain", () => {
    expect(scanLines(line(`c${at}b.co`), ALLOWLIST, [])).toEqual([
      { kind: "email", file: "f.ts", line: 1, domain: "b.co" },
    ]);
  });

  it("matches denylist terms as whole words, case-insensitively, reporting only the index", () => {
    const denylist = parseDenylist("# comment\n\nAcme Corp\n*globex\n");

    expect(scanLines(line("Thanks, ACME corp!"), [], denylist)).toEqual([
      { kind: "term", file: "f.ts", line: 1, term: 1 },
    ]);
    expect(scanLines(line("acme corporation"), [], denylist)).toEqual([]);
    expect(scanLines(line("const GlobexTerminal = 1"), [], denylist)).toEqual([
      { kind: "term", file: "f.ts", line: 1, term: 2 },
    ]);
  });

  it("treats denylist entries as literal text, not patterns", () => {
    const denylist = parseDenylist("a.b");
    expect(scanLines(line("axb"), [], denylist)).toEqual([]);
    expect(scanLines(line("see a.b here"), [], denylist)).toHaveLength(1);
  });
});
