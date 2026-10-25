import { parse } from "acorn";

/**
 * The pinned host registry also assembles filesystem/runtime templates and imports
 * node:crypto. Keep only the factory's source closure before bundling, so none of
 * that host machinery is evaluated in the guest Worker. Declaration bodies stay intact.
 */
export function nimbusFunctionBuildSource(
  source: string,
  file: "commonjs-cell" | "javascript-ast",
): string {
  const names =
    file === "commonjs-cell"
      ? ["REALM", "runtimeFunctionModule"]
      : [
          "applySourceEdits",
          "NODE_TYPES",
          "NON_CHILD_KEYS",
          "isAstNode",
          "forEachChild",
          "forEachNode",
        ];
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const declarations = new Map<string, string>();
  for (const statement of program.body) {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (!node) continue;
    if (node.type === "FunctionDeclaration" && node.id && names.includes(node.id.name)) {
      declarations.set(node.id.name, source.slice(node.start, node.end));
    } else if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier" && names.includes(declaration.id.name)) {
          declarations.set(
            declaration.id.name,
            `${node.kind} ${source.slice(declaration.start, declaration.end)};`,
          );
        }
      }
    }
  }
  for (const name of names) {
    if (!declarations.has(name)) throw new Error(`Pinned Nimbus ${file} is missing ${name}`);
  }
  const imports =
    file === "commonjs-cell"
      ? `import {parseRuntimeFunction, runtimeFunctionSource} from './runtime-function-source.js';
import {applySourceEdits, forEachNode} from '../runtime/javascript-ast.js';`
      : "";
  const exports =
    file === "commonjs-cell" ? ["runtimeFunctionModule"] : ["applySourceEdits", "forEachNode"];
  return `${imports}\n${[...declarations.values()].join("\n")}\nexport {${exports.join(",")}};`;
}
