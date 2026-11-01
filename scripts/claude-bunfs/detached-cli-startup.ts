import ts from "typescript-legacy";
import { CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY } from "@t3tools/contracts/harnessReleaseOmission";

const asyncFunctionNames = (source: ts.SourceFile): Map<string, number> => {
  const names = new Map<string, number>();
  for (const statement of source.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      statement.name === undefined ||
      statement.asteriskToken !== undefined ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      continue;
    names.set(statement.name.text, (names.get(statement.name.text) ?? 0) + 1);
  }
  return names;
};

/** Bind the entry's detached startup task to its owning host before the task starts. */
export function observeDetachedCliStartupRejection(source: string, moduleName: string): string {
  const file = ts.createSourceFile(
    moduleName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const asyncFunctions = asyncFunctionNames(file);
  const candidates = file.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      return [];
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || asyncFunctions.get(call.expression.text) !== 1)
      return [];
    return [{ call, name: call.expression.text }];
  });
  if (candidates.length === 0)
    throw new Error(`BUNDLE_CLAUDE_STARTUP_ASYNC_CALL_MISSING: ${moduleName}`);
  if (candidates.length !== 1)
    throw new Error(`BUNDLE_CLAUDE_STARTUP_ASYNC_CALL_AMBIGUOUS: ${moduleName}`);

  let reporterName = "__signalboxDetachedCliStartupFailure";
  while (source.includes(reporterName)) reporterName += "_";
  const { call } = candidates[0]!;
  const key = JSON.stringify(CLAUDE_CLI_STARTUP_FAILURE_REPORTER_KEY);
  // A late rejection still belongs to this host after the guest's globals have been restored.
  const binding = `const ${reporterName}=process[Symbol.for(${key})];if(typeof ${reporterName}!=="function")throw new Error("CLAUDE_CLI_STARTUP_REPORTER_MISSING");`;
  const start = call.getStart(file);
  return (
    source.slice(0, start) +
    binding +
    source.slice(start, call.end) +
    `.catch(${reporterName})` +
    source.slice(call.end)
  );
}
