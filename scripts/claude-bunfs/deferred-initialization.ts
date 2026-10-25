import * as Esbuild from "esbuild";
import ts from "typescript-legacy";

export type DeferredModuleResolver = (specifier: string, importer: string) => string | undefined;

type VirtualModule = {
  readonly kind: "entry" | "facade" | "namespace";
  readonly target: string;
};

const PREFIX = "signalbox:deferred/";
const NAMESPACE = "signalbox-deferred";

/** Delay release module evaluation until the host explicitly calls launch(). */
export function createDeferredInitialization() {
  const modules = new Map<string, VirtualModule>();

  const virtualSpecifier = (kind: VirtualModule["kind"], target: string): string => {
    const specifier = `${PREFIX}${kind}/${encodeURIComponent(target)}`;
    modules.set(specifier, { kind, target });
    return specifier;
  };

  const namespace = (target: string) => virtualSpecifier("namespace", target);
  const facade = (target: string) => virtualSpecifier("facade", target);

  const plugin: Esbuild.Plugin = {
    name: "signalbox-deferred-initialization",
    setup(build) {
      build.onResolve({ filter: /^signalbox:deferred\// }, (args) => {
        if (!modules.has(args.path))
          throw new Error(`BUNDLE_DEFERRED_MODULE_UNKNOWN: ${args.path}`);
        return { path: args.path, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => {
        const module = modules.get(args.path);
        if (!module) throw new Error(`BUNDLE_DEFERRED_MODULE_UNKNOWN: ${args.path}`);
        if (module.kind === "namespace")
          return {
            contents: `import * as __signalboxDeferredNamespace from ${JSON.stringify(module.target)};\nexport default __signalboxDeferredNamespace;`,
            loader: "js",
          };

        const exportName = module.kind === "entry" ? "launch" : "initialize";
        return {
          contents: `export function ${exportName}(){return require(${JSON.stringify(namespace(module.target))}).default}`,
          loader: "js",
        };
      });
    },
  };

  const entry = (target: string) => virtualSpecifier("entry", target);

  const transform = (source: string, name: string, resolveInternal: DeferredModuleResolver) => {
    const scriptKind = name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, scriptKind);

    const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
    let callbackName = "__signalboxDeferred";
    while (source.includes(callbackName)) callbackName += "_";

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0
      ) {
        const argument = node.arguments[0]!;
        const specifier =
          ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
            ? argument.text
            : undefined;
        if (specifier !== undefined) {
          const target = resolveInternal(specifier, name);
          if (target !== undefined) {
            if (node.arguments.length > 1)
              throw new Error(
                `BUNDLE_DEFERRED_IMPORT_ATTRIBUTES_UNSUPPORTED: ${name}: ${specifier}`,
              );
            edits.push({
              start: argument.getStart(file),
              end: argument.end,
              text: JSON.stringify(facade(target)),
            });
            edits.push({
              start: node.end,
              end: node.end,
              text: `.then((${callbackName})=>${callbackName}.initialize())`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    let output = source;
    for (const edit of edits.sort(
      (left, right) => right.start - left.start || right.end - left.end,
    ))
      output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    return output;
  };

  const linkDynamicImports = (source: string, name: string) => {
    if (!source.includes(PREFIX)) return source;
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1
      ) {
        const argument = node.arguments[0]!;
        if (ts.isStringLiteral(argument) && modules.get(argument.text)?.kind === "facade")
          edits.push({
            start: node.getStart(file),
            end: node.end,
            text: `(async()=>{await 0;return require(${JSON.stringify(argument.text)})})()`,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    let result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    return result;
  };
  return { entry, transform, plugin, linkDynamicImports };
}
