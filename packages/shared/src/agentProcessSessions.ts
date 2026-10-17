// @effect-diagnostics nodeBuiltinImport:off - harness hooks run without installed dependencies.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const sessionPath = (worktreePath: string, sessionId: string) =>
  NodePath.join(
    worktreePath,
    ".t3",
    "agent-sessions",
    `${NodeCrypto.createHash("sha256").update(sessionId).digest("hex")}.json`,
  );

export async function recordSession(worktreePath: string, sessionId: string, ended: boolean) {
  const target = sessionPath(worktreePath, sessionId);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify({ sessionId, ended }), { mode: 0o600 });
  await NodeFSP.rename(temporary, target);
}

export async function sessions(worktreePath: string) {
  const directory = NodePath.join(worktreePath, ".t3", "agent-sessions");
  const names = await NodeFSP.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const value: unknown = JSON.parse(
          await NodeFSP.readFile(NodePath.join(directory, name), "utf8"),
        );
        if (
          typeof value !== "object" ||
          value === null ||
          !("sessionId" in value) ||
          typeof value.sessionId !== "string" ||
          !("ended" in value) ||
          typeof value.ended !== "boolean"
        ) {
          throw new Error("Invalid agent session registration");
        }
        return { sessionId: value.sessionId, ended: value.ended };
      }),
  );
}

export function processSessionId(explicit?: string) {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return NodeCrypto.randomUUID();
}
