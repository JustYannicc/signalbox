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

export async function recordSession(
  worktreePath: string,
  sessionId: string,
  ended: boolean,
  runtimeSessionId?: string,
) {
  const target = sessionPath(worktreePath, sessionId);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(
    temporary,
    JSON.stringify({
      sessionId,
      ended,
      ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    }),
    { mode: 0o600 },
  );
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
          typeof value.ended !== "boolean" ||
          ("runtimeSessionId" in value && typeof value.runtimeSessionId !== "string")
        ) {
          throw new Error("Invalid agent session registration");
        }
        return {
          sessionId: value.sessionId,
          ended: value.ended,
          ...("runtimeSessionId" in value && typeof value.runtimeSessionId === "string"
            ? { runtimeSessionId: value.runtimeSessionId }
            : {}),
        };
      }),
  );
}

export async function ownedSessionId(
  worktreePath: string,
  input: {
    readonly explicit?: string | undefined;
    readonly environmentSessionId?: string | undefined;
    readonly codexThreadId?: string | undefined;
  } = {},
) {
  if (input.explicit !== undefined) {
    if (input.explicit.length === 0) throw new Error("Session ID must not be empty");
    return input.explicit;
  }
  const runtimeId = input.codexThreadId;
  if (runtimeId !== undefined && runtimeId.length > 0) {
    // Native Codex subagent hooks carry the parent session ID separately from the
    // child's runtime ID. Match that exact ID, including when a parent environment is inherited.
    const matches = (await sessions(worktreePath)).filter(
      (session) => (session.runtimeSessionId ?? session.sessionId) === runtimeId,
    );
    if (matches.length > 1) throw new Error("Multiple sessions claim the same Codex thread ID");
    // CODEX_SESSION_ID can belong to a parent. An unbound child owns only its runtime ID.
    return matches[0]?.sessionId ?? runtimeId;
  }
  const environmentId = input.environmentSessionId;
  if (environmentId === undefined || environmentId.length === 0) return undefined;
  // Claude shares its root environment with native subagents, so this ID alone
  // cannot distinguish the parent from a live child.
  if (
    (await sessions(worktreePath)).some(
      (session) => !session.ended && session.sessionId.startsWith(`${environmentId}/`),
    )
  ) {
    throw new Error(
      "Inherited session ownership is ambiguous while subagents are active; pass --session-id explicitly",
    );
  }
  return environmentId;
}

export function processSessionId(explicit?: string) {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return NodeCrypto.randomUUID();
}
