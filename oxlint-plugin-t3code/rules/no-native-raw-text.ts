import { defineRule, type ESTree } from "@oxlint/plugins";

function hasTextParent(node: ESTree.Node, textNames: ReadonlySet<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "JSXElement") {
      const name = parent.openingElement.name;
      return name.type === "JSXIdentifier" && textNames.has(name.name);
    }
    if (parent.type === "JSXAttribute") return true;
  }
  return false;
}

function containsRawText(node: ESTree.Node): boolean {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" || typeof node.value === "number";
    case "TemplateLiteral":
      return true;
    case "ConditionalExpression":
      return containsRawText(node.consequent) || containsRawText(node.alternate);
    case "LogicalExpression":
      // Even an element on the right leaks 0 or an empty string from the left.
      return node.operator !== "&&" || !isBoolean(node.left) || containsRawText(node.right);
    case "ArrayExpression":
      return node.elements.some((element) => element !== null && containsRawText(element));
    case "TSAsExpression":
    case "TSNonNullExpression":
      return containsRawText(node.expression);
    default:
      return false;
  }
}

function isBoolean(node: ESTree.Node): boolean {
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

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep raw text and leaked conditional values out of native views." },
    messages: {
      rawText:
        "React Native text must be inside Text or AppText. Wrap text in Text and use condition ? <Component /> : null instead of a logical render guard.",
    },
  },
  create(context) {
    const textNames = new Set(["Text", "AppText"]);
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "react-native" && !String(node.source.value).endsWith("/AppText"))
          return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = specifier.imported;
          const name = imported.type === "Identifier" ? imported.name : imported.value;
          if (name === "Text" || name === "AppText") textNames.add(specifier.local.name);
        }
      },
      JSXText(node) {
        // JSX drops indentation on multiline blank lines, but keeps a same-line space.
        if ((!node.value.trim() && /[\r\n]/u.test(node.value)) || !node.value) return;
        if (!hasTextParent(node, textNames)) {
          context.report({ node, messageId: "rawText" });
        }
      },
      JSXExpressionContainer(node) {
        if (
          node.parent.type === "JSXAttribute" ||
          hasTextParent(node, textNames) ||
          !containsRawText(node.expression)
        )
          return;
        context.report({ node, messageId: "rawText" });
      },
    };
  },
});
