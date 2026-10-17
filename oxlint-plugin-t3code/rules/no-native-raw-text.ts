import { defineRule, type ESTree } from "@oxlint/plugins";

function elementName(node: ESTree.Node): string {
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression")
    return `${elementName(node.object)}.${node.property.name}`;
  return "";
}

function isChildrenAttribute(node: ESTree.Node): boolean {
  return (
    node.type === "JSXAttribute" &&
    node.name.type === "JSXIdentifier" &&
    node.name.name === "children"
  );
}

function hasTextParent(
  node: ESTree.Node,
  textNames: ReadonlySet<string>,
  fragmentNames: ReadonlySet<string>,
): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "JSXElement") {
      const name = elementName(parent.openingElement.name);
      if (fragmentNames.has(name)) continue;
      return textNames.has(name);
    }
    if (parent.type === "JSXAttribute" && !isChildrenAttribute(parent)) return true;
  }
  return false;
}

function isElementOrNull(node: ESTree.Node): boolean {
  node = unwrapExpression(node);
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true;
  if (node.type === "Literal") return node.value === null;
  if (node.type === "ConditionalExpression")
    return isElementOrNull(node.consequent) && isElementOrNull(node.alternate);
  return false;
}

function unwrapExpression(node: ESTree.Node): ESTree.Node {
  switch (node.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
      return unwrapExpression(node.expression);
    default:
      return node;
  }
}

function isNumeric(node: ESTree.Node): boolean {
  node = unwrapExpression(node);
  switch (node.type) {
    case "Literal":
      return typeof node.value === "number" || typeof node.value === "bigint";
    case "UnaryExpression":
      return node.operator === "+" || node.operator === "-" || node.operator === "~";
    case "BinaryExpression":
      return node.operator === "+"
        ? isNumeric(node.left) && isNumeric(node.right)
        : ["-", "*", "/", "%", "**", "<<", ">>", ">>>", "|", "^", "&"].includes(node.operator);
    default:
      return false;
  }
}

function containsRawText(node: ESTree.Node): boolean {
  node = unwrapExpression(node);
  if (isNumeric(node)) return true;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" && node.value !== "";
    case "TemplateLiteral":
      return node.expressions.length > 0 || node.quasis.some((part) => part.value.cooked !== "");
    case "ConditionalExpression":
      return containsRawText(node.consequent) || containsRawText(node.alternate);
    case "LogicalExpression":
      if (node.operator === "??" && isElementOrNull(node.left) && isElementOrNull(node.right))
        return false;
      return node.operator !== "&&" || !isBoolean(node.left) || containsRawText(node.right);
    case "ArrayExpression":
      return node.elements.some((element) => element !== null && containsRawText(element));
    default:
      return false;
  }
}

function isBoolean(node: ESTree.Node): boolean {
  node = unwrapExpression(node);
  switch (node.type) {
    case "Literal":
      return typeof node.value === "boolean";
    case "UnaryExpression":
      return node.operator === "!";
    case "BinaryExpression":
      return ["===", "!==", "==", "!=", ">", ">=", "<", "<=", "in", "instanceof"].includes(
        node.operator,
      );
    case "LogicalExpression":
      return isBoolean(node.left) && isBoolean(node.right);
    default:
      return false;
  }
}

/**
 * Fork-owned, syntax-only guard: even a boolean identifier in `flag && <Row />`
 * is flagged without type information. Use `cond ? <X /> : null` instead.
 * React Native 0.88's reconciler skips empty-string children before creating text nodes.
 */
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep raw text and leaked conditional values out of native views." },
    schema: [
      {
        type: "object",
        properties: {
          textComponents: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
            description: "Components that render their children inside Text or AppText.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawText:
        "React Native text must be inside Text or AppText. Wrap text in Text and use condition ? <Component /> : null instead of a logical render guard.",
    },
  },
  create(context) {
    const textNames = new Set(["Text", "AppText"]);
    const fragmentNames = new Set(["Fragment", "React.Fragment"]);
    const [options] = context.options;
    if (
      typeof options === "object" &&
      options !== null &&
      "textComponents" in options &&
      Array.isArray(options.textComponents)
    ) {
      for (const name of options.textComponents) {
        if (typeof name === "string") textNames.add(name);
      }
    }
    const inText = (node: ESTree.Node) => hasTextParent(node, textNames, fragmentNames);
    return {
      Program(program) {
        for (const node of program.body) {
          if (node.type !== "ImportDeclaration") continue;
          const source = String(node.source.value);
          if (source !== "react" && source !== "react-native" && !source.endsWith("/AppText"))
            continue;
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportNamespaceSpecifier" ||
              specifier.type === "ImportDefaultSpecifier"
            ) {
              if (source === "react") fragmentNames.add(`${specifier.local.name}.Fragment`);
              else if (source === "react-native") textNames.add(`${specifier.local.name}.Text`);
            } else if (specifier.type === "ImportSpecifier") {
              const imported = specifier.imported;
              const name = imported.type === "Identifier" ? imported.name : imported.value;
              if (source === "react" && name === "Fragment")
                fragmentNames.add(specifier.local.name);
              else if (source !== "react" && (name === "Text" || name === "AppText"))
                textNames.add(specifier.local.name);
            }
          }
        }
      },
      JSXText(node) {
        // JSX drops only ASCII indentation around line breaks, never Unicode spaces.
        if (!node.value || (/^[ \t\r\n]*$/u.test(node.value) && /[\r\n]/u.test(node.value))) return;
        if (!inText(node)) context.report({ node, messageId: "rawText" });
      },
      JSXAttribute(node) {
        if (!isChildrenAttribute(node) || node.value === null || inText(node.value)) return;
        const value =
          node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (containsRawText(value)) context.report({ node: node.value, messageId: "rawText" });
      },
      JSXExpressionContainer(node) {
        if (
          node.parent.type === "JSXAttribute" ||
          inText(node) ||
          !containsRawText(node.expression)
        )
          return;
        context.report({ node, messageId: "rawText" });
      },
    };
  },
});
