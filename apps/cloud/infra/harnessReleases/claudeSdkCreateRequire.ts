import {
  bindingScope,
  isReferenceToBinding,
  type ClaudeSdkAstNode,
} from "./claudeSdkCreateRequireScope.ts";
import {
  analyzeClaudeSdkCreateRequireSource,
  identifier,
  isAstNode,
  staticString,
  validCreateRequireBase,
} from "./claudeSdkCreateRequireSyntax.ts";

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Rebind static calls; keep resolve on NodeModule's prepared-graph resolver. */
export function rewriteClaudeSdkCreateRequire(source: string) {
  const { nodes, parentByNode, factoryCalls, fileURLToPathFactories, urlNamespaces } =
    analyzeClaudeSdkCreateRequireSource(source);
  const declarations: ClaudeSdkAstNode[] = [];
  for (const factory of factoryCalls) {
    const declaration = parentByNode.get(factory);
    if (
      !declaration ||
      declaration.type !== "VariableDeclarator" ||
      !identifier(declaration.id) ||
      declaration.init !== factory
    )
      throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
    if (
      !validCreateRequireBase(
        factory,
        declaration,
        parentByNode,
        fileURLToPathFactories,
        urlNamespaces,
      )
    )
      throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
    const bindingName = String(declaration.id.name);
    const scope = bindingScope(declaration, parentByNode);
    if (!scope) throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
    if (
      declarations.some(
        (existing) =>
          identifier(existing.id, bindingName) && bindingScope(existing, parentByNode) === scope,
      )
    )
      throw new Error("CLAUDE_SDK_CREATE_REQUIRE_NAME_CONFLICT");
    declarations.push(declaration);
  }
  if (factoryCalls.length === 0) return { contents: source, rewrittenCalls: 0 };

  const edits: Edit[] = [];
  const exportedRequireBindings = new Map<ClaudeSdkAstNode, Set<ClaudeSdkAstNode>>();
  let rewrittenCalls = 0;
  for (const { node, parent } of nodes) {
    if (!identifier(node)) continue;
    const matchingBindings = declarations.filter((declaration) =>
      isReferenceToBinding(node, declaration, parentByNode),
    );
    if (matchingBindings.length === 0) continue;
    if (matchingBindings.length > 1) throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
    if (parent?.type === "ExportSpecifier" && parent.local === node) {
      const statement = parentByNode.get(parent);
      if (
        statement?.type !== "ExportNamedDeclaration" ||
        statement.source !== null ||
        !Array.isArray(statement.specifiers)
      )
        throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
      const removed = exportedRequireBindings.get(statement) ?? new Set<ClaudeSdkAstNode>();
      removed.add(parent);
      exportedRequireBindings.set(statement, removed);
      continue;
    }
    if (parent?.type === "CallExpression" && parent.callee === node) {
      if (
        !Array.isArray(parent.arguments) ||
        parent.arguments.length !== 1 ||
        staticString(parent.arguments[0]) === undefined
      )
        throw new Error("CLAUDE_SDK_CREATE_REQUIRE_DYNAMIC_SPECIFIER");
      if (node.name !== "require")
        edits.push({ start: node.start, end: node.end, text: "require" });
      rewrittenCalls += 1;
      continue;
    }
    if (
      parent?.type === "MemberExpression" &&
      parent.object === node &&
      parent.computed !== true &&
      identifier(parent.property, "resolve")
    ) {
      const resolution = parentByNode.get(parent);
      if (
        resolution?.type === "CallExpression" &&
        resolution.callee === parent &&
        Array.isArray(resolution.arguments) &&
        resolution.arguments.length === 1
      )
        continue;
    }
    throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
  }

  for (const [statement, removed] of exportedRequireBindings) {
    const specifiers = statement.specifiers;
    if (!Array.isArray(specifiers) || specifiers.some((item) => !isAstNode(item)))
      throw new Error("CLAUDE_SDK_CREATE_REQUIRE_FLOW_UNSUPPORTED");
    const kept = specifiers.filter((item): item is ClaudeSdkAstNode => !removed.has(item));
    // A consumer of this internal export now fails module resolution instead of escaping the graph.
    edits.push({
      start: statement.start,
      end: statement.end,
      text:
        kept.length === 0
          ? ""
          : `export {${kept.map((item) => source.slice(item.start, item.end)).join(", ")}};`,
    });
  }

  edits.sort((left, right) => right.start - left.start);
  for (let index = 1; index < edits.length; index++)
    if (edits[index - 1]!.start < edits[index]!.end)
      throw new Error("CLAUDE_SDK_CREATE_REQUIRE_EDIT_OVERLAP");
  let contents = source;
  for (const edit of edits)
    contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
  return { contents, rewrittenCalls };
}
