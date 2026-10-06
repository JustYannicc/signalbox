import type {
  WorkflowArm,
  WorkflowLabel,
  WorkflowNode,
  WorkflowStepVerb,
} from "@t3tools/contracts";
import type {
  ArrowFunctionExpression,
  CallExpression,
  Function as FunctionExpression,
  IfStatement,
  Node,
  SwitchStatement,
} from "oxc-parser";

import { loopLabel, OTHERWISE, plainLabel } from "./labels.ts";
import { objectProperties, propertyKey, readLabel, readString, unwrap } from "./literals.ts";
import type { WorkflowSource } from "./source.ts";
import { isOutcomeVerb, isStepVerb, VERB_LIST, readPositiveInt, readStepDetail } from "./verbs.ts";
import { children, isFunctionNode, someNode } from "./walk.ts";

export type FunctionNode = FunctionExpression | ArrowFunctionExpression;

/**
 * A `judge` or `ask` result held in a const, so code can branch on its answer.
 * `member` is set when the answer is a property of it (`reply.choice` of an ask with fields).
 */
interface Decider {
  readonly id: string;
  readonly label: WorkflowLabel;
  readonly outcomes: ReadonlyArray<string>;
  readonly member: string | null;
}

/**
 * Where the analyzer is. `receivers` are the step receivers in lexical scope,
 * innermost last; `prefix` is prepended to node ids so a helper inlined twice,
 * or a loop callback's body, gets ids of its own.
 */
interface Scope {
  readonly receivers: ReadonlyArray<string>;
  readonly prefix: string;
  readonly exit: "workflow" | "callback" | "helper";
  readonly inRepeat: boolean;
  readonly deciders: Map<string, Decider>;
  readonly helpers: ReadonlyMap<string, FunctionNode>;
  readonly helperStack: ReadonlyArray<string>;
}

/** A source change applied before types are stripped. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Globals the sandbox doesn't have, with the step that does the job instead. */
const UNAVAILABLE_GLOBALS = new Map([
  ["fetch", "Use w.http for requests, or w.call for a connected service."],
  ["XMLHttpRequest", "Use w.http for requests, or w.call for a connected service."],
  ["WebSocket", "Use w.run for code that needs sockets."],
  ["setTimeout", "Use w.sleep to wait."],
  ["setInterval", "Use w.sleep in a loop, or a cron trigger."],
  ["setImmediate", "Steps run as soon as they're reached; there's nothing to defer."],
  [
    "require",
    "Import packages at the top of the file and use them inside a function passed to w.run.",
  ],
  ["process", "Use w.run for code that needs the machine."],
  ["eval", "Write the code directly."],
  ["Function", "Write the code directly."],
  [
    "Intl",
    "Format in plain code, e.g. date.toISOString().slice(0, 10), or format inside a w.run function.",
  ],
  [
    "URL",
    "Build URLs with template strings and encodeURIComponent, or URLSearchParams for query strings; or parse URLs inside a w.run function.",
  ],
  ["Buffer", "Use btoa/atob for base64 and TextEncoder/TextDecoder for bytes, or w.run."],
  ["performance", "Use Date.now()."],
  ["AbortController", "Steps can't be cancelled from code; use w.run for code that needs it."],
  ["AbortSignal", "Steps can't be cancelled from code; use w.run for code that needs it."],
  ["Blob", "Pass text or JSON between steps, or handle files inside a w.run function."],
  ["FormData", "Send a JSON body with w.http, or build the upload inside a w.run function."],
  ["Response", "Use w.http; it returns { status, ok, headers, body } as plain data."],
  ["Request", "Use w.http; pass { url, method, headers, body } as plain data."],
  ["Headers", "Use w.http and pass headers as a plain object."],
]);
const CALLBACK_HINT =
  "Use w.each to run steps per item (with a concurrency limit), w.parallel for named concurrent branches, or a plain for loop.";
const RUN_HINT =
  'Define it at the top level of this file, e.g. async function parsePdf(url: string) { … }, then await w.run("Parse the PDF", parsePdf, url).';
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isFunction(node: Node | undefined | null): node is FunctionNode {
  return !!node && isFunctionNode(node);
}

function firstParamName(fn: FunctionNode) {
  const param = fn.params[0];
  return param?.type === "Identifier" ? param.name : null;
}

function strip(test: Node) {
  let node = unwrap(test);
  let negated = false;
  while (node.type === "UnaryExpression" && node.operator === "!") {
    negated = !negated;
    node = unwrap(node.argument);
  }
  return { node, negated };
}

/** Turns workflow code into the graph tree, collecting diagnostics and source edits on the way. */
export class WorkflowAnalyzer {
  readonly edits = new Map<string, Edit>();
  /** Top-level functions passed to `w.run`; they run outside the sandbox. */
  readonly runFunctions = new Set<string>();
  private readonly sites = new Map<string, string>();
  /**
   * Helpers already inlined once. A helper called from several places is
   * analyzed per call for the graph, but its code exists once, so its source
   * edits are only made the first time.
   */
  private readonly inlined = new Set<FunctionNode>();
  private repeatedHelpers = 0;
  /** Steps with outcomes that code branches on, and where their answer is. */
  private readonly decisions = new Map<string, "value" | "choice">();
  private readonly source: WorkflowSource;
  private readonly declared: ReadonlySet<string>;
  private readonly imported: ReadonlySet<string>;
  private readonly moduleFunctions: ReadonlyMap<string, FunctionNode>;

  constructor(options: {
    source: WorkflowSource;
    declared: ReadonlySet<string>;
    imported: ReadonlySet<string>;
    moduleFunctions: ReadonlyMap<string, FunctionNode>;
  }) {
    this.source = options.source;
    this.declared = options.declared;
    this.imported = options.imported;
    this.moduleFunctions = options.moduleFunctions;
  }

  /** Analyzes `workflow(async (w, input) => { … })`'s callback. */
  workflow(fn: FunctionNode): WorkflowNode[] {
    const receiver = firstParamName(fn);
    if (!receiver || !fn.async) {
      this.source.error(
        fn,
        "The workflow callback must be async and name the receiver first.",
        "workflow(async (w, input) => { … })",
      );
      return [];
    }
    return this.functionBody(fn, {
      receivers: [receiver],
      prefix: "",
      exit: "workflow",
      inRepeat: false,
      deciders: new Map(),
      helpers: this.moduleFunctions,
      helperStack: [],
    });
  }

  /** Checks module-level code, which can't run steps but is replayed like everything else. */
  topLevel(statement: Node) {
    this.scan(
      statement,
      {
        receivers: [],
        prefix: "",
        exit: "workflow",
        inRepeat: false,
        deciders: new Map(),
        helpers: new Map(),
        helperStack: [],
      },
      null,
      [],
    );
  }

  /** Functions declared directly in `statements`, by name. */
  static functionsIn(
    statements: ReadonlyArray<Node>,
    outer: ReadonlyMap<string, FunctionNode> = new Map(),
  ) {
    const functions = new Map(outer);
    for (const statement of statements) {
      const declaration =
        statement.type === "ExportNamedDeclaration" && statement.declaration
          ? statement.declaration
          : statement;
      if (declaration.type === "FunctionDeclaration" && declaration.id) {
        functions.set(declaration.id.name, declaration);
      } else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          const init = declarator.init ? unwrap(declarator.init) : null;
          if (declarator.id.type === "Identifier" && isFunction(init)) {
            functions.set(declarator.id.name, init);
          }
        }
      }
    }
    return functions;
  }

  /** Stable per call site, so a helper inlined twice reuses its inner ids under different prefixes. */
  private site(node: Node) {
    const key = `${node.type}:${node.start}`;
    let id = this.sites.get(key);
    if (!id) {
      id = `s${this.sites.size + 1}`;
      this.sites.set(key, id);
    }
    return id;
  }

  /** Passes the site id to the runtime as the verb's first argument. */
  private tagSite(call: CallExpression, site: string) {
    const first = call.arguments[0];
    if (first) {
      this.edits.set(`site:${first.start}`, {
        start: first.start,
        end: first.start,
        text: `${JSON.stringify(site)}, `,
      });
    }
  }

  private insert(at: number, text: string) {
    if (this.repeatedHelpers > 0) return;
    this.edits.set(`insert:${this.edits.size}:${at}`, { start: at, end: at, text });
  }

  /** Code that records, at run time, that option `index` of decision `site` was taken. */
  private armMark(scope: Scope, site: string, index: number) {
    return `${scope.receivers.at(-1)}.$arm(${JSON.stringify(site)}, ${index});`;
  }

  /** Records option `index` when `body` runs, wrapping a lone statement in braces. */
  private markStatement(scope: Scope, site: string, index: number, body: Node) {
    const mark = this.armMark(scope, site, index);
    if (body.type === "BlockStatement") {
      this.insert(body.start + 1, ` ${mark}`);
    } else {
      this.insert(body.start, `{ ${mark} `);
      this.insert(body.end, " }");
    }
  }

  /** Records option `index` when an expression arm (`a ? b : c`, `a && b`) is evaluated. */
  private markExpression(scope: Scope, site: string, index: number, expression: Node) {
    const receiver = scope.receivers.at(-1);
    this.insert(expression.start, `(${receiver}.$arm(${JSON.stringify(site)}, ${index}), `);
    this.insert(expression.end, ")");
  }

  /**
   * Marks every option of an if / else if / else chain. A chain without a
   * final else gets one, so the "otherwise" option is recorded too.
   */
  private markIfChain(
    scope: Scope,
    site: string,
    statement: IfStatement,
    cases: ReadonlyArray<{ body: Node }>,
    otherwise: Node | null,
  ) {
    cases.forEach((entry, index) => this.markStatement(scope, site, index, entry.body));
    if (otherwise) this.markStatement(scope, site, cases.length, otherwise);
    else this.insert(statement.end, ` else { ${this.armMark(scope, site, cases.length)} }`);
  }

  private functionBody(fn: FunctionNode, scope: Scope): WorkflowNode[] {
    const body = fn.body;
    if (!body) return [];
    if (body.type === "BlockStatement") {
      const helpers = WorkflowAnalyzer.functionsIn(body.body, scope.helpers);
      return this.block(body.body, { ...scope, helpers }, true);
    }
    return this.expressionArm(body, scope);
  }

  private block(statements: ReadonlyArray<Node>, scope: Scope, functionBody: boolean) {
    const out: WorkflowNode[] = [];
    statements.forEach((statement, index) => {
      this.statement(statement, scope, out, functionBody && index === statements.length - 1);
    });
    return out;
  }

  private arm(statement: Node | null | undefined, scope: Scope) {
    if (!statement) return [];
    if (statement.type === "BlockStatement") return this.block(statement.body, scope, false);
    const out: WorkflowNode[] = [];
    this.statement(statement, scope, out, false);
    return out;
  }

  private expressionArm(expression: Node | null | undefined, scope: Scope) {
    const out: WorkflowNode[] = [];
    this.scan(expression, scope, null, out);
    return out;
  }

  /** Whether code changes which steps run: it uses a receiver or returns early. */
  private shapesGraph(node: Node | null | undefined, scope: Scope) {
    return someNode(
      node,
      (child) =>
        child.type === "ReturnStatement" ||
        (child.type === "Identifier" && scope.receivers.includes(child.name)),
    );
  }

  private statement(statement: Node, scope: Scope, out: WorkflowNode[], tail: boolean): void {
    switch (statement.type) {
      case "ExpressionStatement":
        this.scan(statement.expression, scope, null, out);
        return;
      case "VariableDeclaration":
        for (const declarator of statement.declarations) {
          if (!declarator.init) continue;
          const from = out.length;
          this.scan(declarator.init, scope, null, out);
          if (statement.kind === "const") {
            this.rememberDecider(declarator.id, declarator.init, scope, out.slice(from));
          }
        }
        return;
      case "ReturnStatement":
        this.returnStatement(statement, scope, out, tail);
        return;
      case "IfStatement":
        this.ifStatement(statement, scope, out);
        return;
      case "SwitchStatement":
        this.switchStatement(statement, scope, out);
        return;
      case "BlockStatement":
        out.push(...this.block(statement.body, scope, false));
        return;
      case "LabeledStatement":
        this.statement(statement.body, scope, out, false);
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        this.loopStatement(statement, scope, out);
        return;
      case "TryStatement":
        if (!this.shapesGraph(statement, scope)) {
          this.scan(statement, scope, null, out);
          return;
        }
        // `try { … } finally { … }` has no failure path to draw: its steps run in order.
        if (!statement.handler) {
          out.push(...this.block(statement.block.body, scope, false));
          if (statement.finalizer) out.push(...this.block(statement.finalizer.body, scope, false));
          return;
        }
        {
          const site = this.site(statement);
          this.markStatement(scope, site, 0, statement.block);
          this.markStatement(scope, site, 1, statement.handler.body);
        }
        out.push({
          type: "try",
          id: `${scope.prefix}${this.site(statement)}`,
          line: this.source.line(statement),
          label: {
            text: this.source.commentBefore(statement) ?? "If something fails",
            dynamic: false,
          },
          body: this.block(statement.block.body, scope, false),
          failure: this.block(statement.handler.body.body, scope, false),
        });
        if (statement.finalizer) out.push(...this.block(statement.finalizer.body, scope, false));
        return;
      default:
        this.scan(statement, scope, null, out);
    }
  }

  private loopStatement(
    statement: Extract<
      Node,
      {
        type:
          | "ForStatement"
          | "ForInStatement"
          | "ForOfStatement"
          | "WhileStatement"
          | "DoWhileStatement";
      }
    >,
    scope: Scope,
    out: WorkflowNode[],
  ) {
    if (!this.shapesGraph(statement, scope)) {
      this.scan(statement, scope, null, out);
      return;
    }
    if (statement.type === "ForOfStatement" || statement.type === "ForInStatement") {
      this.scan(statement.right, scope, null, out);
    } else if (statement.type === "ForStatement") {
      this.scan(statement.init, scope, null, out);
    }
    this.markStatement(scope, this.site(statement), 0, statement.body);
    out.push({
      type: "loop",
      id: `${scope.prefix}${this.site(statement)}`,
      line: this.source.line(statement),
      verb:
        statement.type === "WhileStatement" || statement.type === "DoWhileStatement"
          ? "while"
          : "for",
      label: {
        text: this.source.commentBefore(statement) ?? loopLabel(this.source, statement),
        dynamic: false,
      },
      body: this.arm(statement.body, scope),
    });
  }

  /** `const kind = await w.judge(…)`, `const reply = await w.ask(…)`, or `const { choice } = …`. */
  private rememberDecider(
    target: Node,
    init: Node,
    scope: Scope,
    produced: ReadonlyArray<WorkflowNode>,
  ) {
    const value = unwrap(init);
    const call = value.type === "AwaitExpression" ? unwrap(value.argument) : value;
    const verb = this.verbOf(call, scope);
    if (!verb || !isOutcomeVerb(verb)) return;
    const id = `${scope.prefix}${this.site(call)}`;
    const node = produced.find((candidate) => candidate.id === id);
    const decision = this.decisions.get(id);
    if (node?.type !== "step" || !node.outcomes || !decision) return;
    const decider = { id, label: node.label, outcomes: node.outcomes };
    if (target.type === "Identifier") {
      scope.deciders.set(target.name, {
        ...decider,
        member: decision === "choice" ? "choice" : null,
      });
      return;
    }
    if (target.type !== "ObjectPattern" || decision !== "choice") return;
    for (const property of target.properties) {
      if (property.type === "Property" && propertyKey(property) === "choice") {
        if (property.value.type === "Identifier") {
          scope.deciders.set(property.value.name, { ...decider, member: null });
        }
      }
    }
  }

  /** The decider whose answer `node` reads: `kind`, or `reply.choice` for an ask with fields. */
  private deciderOf(node: Node, scope: Scope): Decider | null {
    const target = unwrap(node);
    if (target.type === "Identifier") {
      const decider = scope.deciders.get(target.name);
      if (decider?.member) {
        this.source.error(
          target,
          `"${target.name}" is { ${decider.member}, values } because this ask has fields; compare ${target.name}.${decider.member}.`,
        );
        return null;
      }
      return decider ?? null;
    }
    if (
      target.type === "MemberExpression" &&
      !target.computed &&
      target.object.type === "Identifier" &&
      target.property.type === "Identifier"
    ) {
      const decider = scope.deciders.get(target.object.name);
      return decider?.member === target.property.name ? decider : null;
    }
    return null;
  }

  /** The verb when `node` is `receiver.verb(…)` on a receiver in scope. */
  private verbOf(node: Node, scope: Scope): string | null {
    if (node.type !== "CallExpression") return null;
    const callee = unwrap(node.callee);
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      scope.receivers.includes(callee.object.name) &&
      callee.property.type === "Identifier"
    ) {
      return callee.property.name;
    }
    return null;
  }

  private returnStatement(
    statement: Extract<Node, { type: "ReturnStatement" }>,
    scope: Scope,
    out: WorkflowNode[],
    tail: boolean,
  ) {
    const argument = statement.argument ? unwrap(statement.argument) : null;
    const line = this.source.line(statement);
    const id = () => `${scope.prefix}${this.site(statement)}`;
    if (argument && this.verbOf(argument, scope) === "done") {
      const call = argument as CallExpression;
      if (!scope.inRepeat) {
        this.source.error(argument, "w.done() only works inside a w.repeat callback.");
        return;
      }
      if (this.ownReceiver(call, scope)) {
        for (const value of call.arguments) this.scan(value, scope, "inside w.done", out);
        out.push({ type: "end", id: id(), line, exit: "callback", done: true });
      }
      return;
    }
    if (statement.argument) this.scan(statement.argument, scope, null, out);
    if (!tail) out.push({ type: "end", id: id(), line, exit: scope.exit });
  }

  /** The label of one condition: `w.when`'s label, or the condition's code. Tags `when` calls. */
  private conditionLabel(test: Node, scope: Scope, out: WorkflowNode[]) {
    const { node, negated } = strip(test);
    if (this.verbOf(node, scope) === "when") {
      const call = node as CallExpression;
      const label = readLabel(call.arguments[0]);
      if (!label) {
        this.source.error(
          call,
          "w.when needs a label first.",
          'if (w.when("Any new issues?", issues.length > 0))',
        );
      }
      const condition = call.arguments[1];
      if (!condition) this.source.error(call, "w.when needs a condition after its label.");
      else this.scan(condition, scope, "inside a w.when condition", out);
      const site = this.site(call);
      if (this.ownReceiver(call, scope)) this.tagSite(call, site);
      return { ...(label ?? { text: "?", dynamic: false }), negated, site };
    }
    this.scan(test, scope, null, out);
    return { ...plainLabel(this.source, test), negated: false, site: null };
  }

  /**
   * `if`/`else if`/`else` becomes one decision with an arm per option. When
   * every condition compares the same `judge`/`ask` answer, the arms are its
   * outcomes.
   */
  private ifStatement(statement: IfStatement, scope: Scope, out: WorkflowNode[]) {
    const cases: { test: Node; body: Node }[] = [];
    let otherwise: Node | null = null;
    for (let current: IfStatement = statement; ;) {
      cases.push({ test: current.test, body: current.consequent });
      if (current.alternate?.type === "IfStatement") {
        current = current.alternate;
        continue;
      }
      otherwise = current.alternate ?? null;
      break;
    }
    const shapes =
      cases.some(
        (entry) => this.shapesGraph(entry.body, scope) || this.shapesGraph(entry.test, scope),
      ) || this.shapesGraph(otherwise, scope);
    if (!shapes) {
      this.scan(statement, scope, null, out);
      return;
    }
    const line = this.source.line(statement);
    const comment = this.source.commentBefore(statement);

    const comparisons = cases.map((entry) => this.deciderComparison(entry.test, scope));
    const decider = comparisons[0]?.decider;
    if (decider && comparisons.every((comparison) => comparison?.decider === decider)) {
      const covered = new Set<string>();
      const arms: WorkflowArm[] = cases.map((entry, index) => {
        const matched = comparisons[index]!.matches.filter((outcome) => !covered.has(outcome));
        for (const outcome of matched) covered.add(outcome);
        return { label: matched.join(" / "), body: this.arm(entry.body, scope) };
      });
      const rest = decider.outcomes.filter((outcome) => !covered.has(outcome));
      if (rest.length > 0 || otherwise) {
        arms.push({ label: rest.join(" / ") || OTHERWISE, body: this.arm(otherwise, scope) });
      }
      this.markIfChain(scope, this.site(statement), statement, cases, otherwise);
      out.push({
        type: "branch",
        id: `${scope.prefix}${this.site(statement)}`,
        line,
        source: "outcome",
        label: decider.label,
        decidedBy: decider.id,
        arms,
      });
      return;
    }

    const labels = cases.map((entry) => this.conditionLabel(entry.test, scope, out));
    // A lone `w.when` decision takes the call's id, so the runtime's record of the answer lands on it.
    const id = `${scope.prefix}${(cases.length === 1 && labels[0]!.site) || this.site(statement)}`;
    // A lone `w.when` already records its answer; everything else records the option taken.
    if (!(cases.length === 1 && labels[0]!.site)) {
      this.markIfChain(scope, this.site(statement), statement, cases, otherwise);
    }
    if (cases.length === 1) {
      const only = labels[0]!;
      const yes = this.arm(cases[0]!.body, scope);
      const no = this.arm(otherwise, scope);
      out.push({
        type: "branch",
        id,
        line,
        source: "condition",
        label: comment
          ? { text: comment, dynamic: false }
          : { text: only.text, dynamic: only.dynamic },
        arms: [
          { label: "Yes", body: only.negated ? no : yes },
          { label: "No", body: only.negated ? yes : no },
        ],
      });
      return;
    }
    out.push({
      type: "branch",
      id,
      line,
      source: "condition",
      label: { text: comment ?? "Which case?", dynamic: false },
      arms: [
        ...cases.map((entry, index) => ({
          label: `${labels[index]!.negated ? "not " : ""}${labels[index]!.text}`,
          body: this.arm(entry.body, scope),
        })),
        { label: OTHERWISE, body: this.arm(otherwise, scope) },
      ],
    });
  }

  /** `kind === "bug"` (either side, `!==` too) where `kind` holds a `judge` or `ask` answer. */
  private deciderComparison(
    test: Node,
    scope: Scope,
  ): { decider: Decider; matches: string[] } | null {
    const { node, negated } = strip(test);
    if (node.type !== "BinaryExpression" || !["===", "==", "!==", "!="].includes(node.operator))
      return null;
    const left = unwrap(node.left);
    const right = unwrap(node.right);
    const [decider, literal] =
      readString(right) !== null
        ? [this.deciderOf(left, scope), right]
        : [this.deciderOf(right, scope), left];
    const outcome = readString(literal);
    if (!decider || outcome === null) return null;
    if (!decider.outcomes.includes(outcome)) {
      this.source.error(
        literal,
        `"${outcome}" isn't one of the possible answers: ${decider.outcomes.join(", ")}.`,
      );
    }
    const equal = (node.operator === "===" || node.operator === "==") !== negated;
    return {
      decider,
      matches: equal ? [outcome] : decider.outcomes.filter((other) => other !== outcome),
    };
  }

  private switchStatement(statement: SwitchStatement, scope: Scope, out: WorkflowNode[]) {
    if (
      !statement.cases.some((entry) =>
        entry.consequent.some((child) => this.shapesGraph(child, scope)),
      )
    ) {
      this.scan(statement, scope, null, out);
      return;
    }
    const discriminant = unwrap(statement.discriminant);
    const decider = this.deciderOf(discriminant, scope);
    if (!decider) this.scan(statement.discriminant, scope, null, out);

    const arms: WorkflowArm[] = [];
    const covered = new Set<string>();
    let pending: string[] = [];
    let defaultArm = -1;
    statement.cases.forEach((entry, index) => {
      if (!entry.test) {
        defaultArm = arms.length;
      } else if (decider) {
        const outcome = readString(entry.test);
        if (outcome === null || !decider.outcomes.includes(outcome)) {
          this.source.error(
            entry.test,
            `Each case must be one of the possible answers: ${decider.outcomes.join(", ")}.`,
          );
          return;
        }
        pending.push(outcome);
        covered.add(outcome);
      } else {
        pending.push(plainLabel(this.source, entry.test).text);
      }
      if (entry.consequent.length === 0) return;
      let body = entry.consequent;
      const last = body.at(-1);
      if (last?.type === "BreakStatement" && !last.label) {
        body = body.slice(0, -1);
      } else if (
        last?.type !== "ReturnStatement" &&
        last?.type !== "ThrowStatement" &&
        index < statement.cases.length - 1
      ) {
        this.source.error(
          entry,
          "End each case with break or return; falling through into the next case isn't supported.",
        );
      }
      this.insert(
        entry.consequent[0]!.start,
        `${this.armMark(scope, this.site(statement), arms.length)} `,
      );
      arms.push({ label: pending.join(" / "), body: this.block(body, scope, false) });
      pending = [];
    });
    if (pending.length > 0) arms.push({ label: pending.join(" / "), body: [] });

    const rest = decider
      ? decider.outcomes.filter((outcome) => !covered.has(outcome)).join(" / ")
      : "";
    if (defaultArm >= 0) {
      const arm = arms[defaultArm]!;
      arms[defaultArm] = {
        ...arm,
        label: [arm.label, rest || OTHERWISE].filter(Boolean).join(" / "),
      };
    } else if (rest || !decider) {
      arms.push({ label: rest || OTHERWISE, body: [] });
    }
    const id = `${scope.prefix}${this.site(statement)}`;
    const line = this.source.line(statement);
    const comment = this.source.commentBefore(statement);
    out.push(
      decider
        ? {
            type: "branch",
            id,
            line,
            source: "outcome",
            label: decider.label,
            decidedBy: decider.id,
            arms,
          }
        : {
            type: "branch",
            id,
            line,
            source: "condition",
            label: comment
              ? { text: comment, dynamic: false }
              : plainLabel(this.source, discriminant),
            arms,
          },
    );
  }

  /**
   * Walks an expression or statement in evaluation order and appends a node
   * for every step it runs. `context` says why steps aren't allowed here, or
   * is null where they are.
   */
  private scan(
    node: Node | null | undefined,
    scope: Scope,
    context: string | null,
    out: WorkflowNode[],
  ): void {
    if (!node) return;
    switch (node.type) {
      case "CallExpression":
        if (this.call(node, scope, context, out)) return;
        break;
      case "Identifier":
        this.identifier(node, scope, context);
        return;
      case "ConditionalExpression":
      case "LogicalExpression": {
        const [test, ...rest] =
          node.type === "ConditionalExpression"
            ? [node.test, node.consequent, node.alternate]
            : [node.left, node.right];
        if (context || !rest.some((part) => this.shapesGraph(part, scope))) break;
        this.scan(test, scope, null, out);
        const site = this.site(node);
        rest.forEach((part, index) => {
          // `a || b` evaluates b on the "No" option.
          const option = node.type === "LogicalExpression" && node.operator === "||" ? 1 : index;
          this.markExpression(scope, site, option, part);
        });
        const [first, second] = rest.map((part) => this.expressionArm(part, scope));
        const arms =
          node.type === "ConditionalExpression"
            ? [
                { label: "Yes", body: first! },
                { label: "No", body: second! },
              ]
            : node.operator === "&&"
              ? [
                  { label: "Yes", body: first! },
                  { label: "No", body: [] },
                ]
              : node.operator === "||"
                ? [
                    { label: "Yes", body: [] },
                    { label: "No", body: first! },
                  ]
                : [
                    { label: "Missing", body: first! },
                    { label: "Set", body: [] },
                  ];
        out.push({
          type: "branch",
          id: `${scope.prefix}${this.site(node)}`,
          line: this.source.line(node),
          source: "condition",
          label: plainLabel(this.source, test),
          arms,
        });
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        if (node.type === "FunctionDeclaration" && node.id && this.runFunctions.has(node.id.name))
          return;
        const params = new Set(
          node.params.flatMap((param) => (param.type === "Identifier" ? [param.name] : [])),
        );
        const inner = { ...scope, receivers: scope.receivers.filter((name) => !params.has(name)) };
        if (node.body) this.scan(node.body, inner, context ?? "inside a callback", out);
        return;
      }
      case "ImportExpression":
        this.source.error(node, "Dynamic import() isn't available here.", RUN_HINT);
        return;
    }
    for (const child of children(node)) this.scan(child, scope, context, out);
  }

  private identifier(
    node: Extract<Node, { type: "Identifier" }>,
    scope: Scope,
    context: string | null,
  ) {
    if (scope.receivers.includes(node.name)) {
      this.source.error(
        node,
        context
          ? `Steps can't run ${context}.`
          : `${node.name} can only call steps, or be passed as the first argument to a helper function.`,
        context
          ? CALLBACK_HINT
          : "Helpers look like async function triage(w, issue) { … } and are called as await triage(w, issue).",
      );
    } else if (this.imported.has(node.name)) {
      this.source.error(
        node,
        `${node.name} is an imported package, which only works inside a function passed to w.run.`,
        RUN_HINT,
      );
    } else if (UNAVAILABLE_GLOBALS.has(node.name) && !this.declared.has(node.name)) {
      this.source.error(
        node,
        `${node.name} isn't available in automation code.`,
        UNAVAILABLE_GLOBALS.get(node.name),
      );
    }
  }

  /** Steps must use the innermost receiver, so each iteration and branch is tracked on its own. */
  private ownReceiver(call: CallExpression, scope: Scope) {
    const callee = unwrap(call.callee);
    const name =
      callee.type === "MemberExpression" && callee.object.type === "Identifier"
        ? callee.object.name
        : null;
    const own = scope.receivers.at(-1);
    if (name === own) return true;
    this.source.error(
      call,
      `Use ${own}, the receiver this callback gets, instead of ${name}.`,
      CALLBACK_HINT,
    );
    return false;
  }

  private label(call: CallExpression) {
    const label = readLabel(call.arguments[0]);
    if (!label) {
      this.source.error(
        call.arguments[0] ?? call,
        "The first argument must be a label for the diagram, written as a string.",
        'e.g. await w.agent("Draft a reply", { prompt })',
      );
    }
    return label;
  }

  /** Handles verb, helper and `Promise.all` calls. Returns false for ordinary calls, which `scan` walks normally. */
  private call(call: CallExpression, scope: Scope, context: string | null, out: WorkflowNode[]) {
    const callee = unwrap(call.callee);
    const verb = this.verbOf(call, scope);
    if (verb !== null) {
      if (context) {
        this.source.error(call, `Steps can't run ${context}.`, CALLBACK_HINT);
        return true;
      }
      if (!this.ownReceiver(call, scope)) return true;
      if (isStepVerb(verb)) this.step(call, verb, scope, out);
      else if (verb === "each" || verb === "repeat") this.loop(call, verb, scope, out);
      else if (verb === "parallel") this.parallel(call, scope, out);
      else if (verb === "when") {
        this.source.error(
          call,
          "w.when labels an if condition.",
          'if (w.when("Any new issues?", issues.length > 0)) { … }',
        );
      } else if (verb === "done") {
        this.source.error(call, "Return w.done() from a w.repeat callback: return w.done(value).");
      } else {
        this.source.error(callee, `w.${verb} isn't a step. Available: ${VERB_LIST}.`);
      }
      return true;
    }

    const firstArgument = call.arguments[0] ? unwrap(call.arguments[0]) : null;
    if (
      callee.type === "Identifier" &&
      firstArgument?.type === "Identifier" &&
      scope.receivers.includes(firstArgument.name)
    ) {
      this.helperCall(call, callee.name, firstArgument, scope, context, out);
      return true;
    }

    const all =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      callee.object.name === "Promise" &&
      callee.property.type === "Identifier" &&
      ["all", "allSettled"].includes(callee.property.name);
    const list = firstArgument?.type === "ArrayExpression" ? firstArgument : null;
    if (all && list && !context && this.shapesGraph(list, scope)) {
      const branches = list.elements.flatMap((element, index) => {
        if (!element || element.type === "SpreadElement") return [];
        const body = this.expressionArm(element, scope);
        const first = body[0];
        return [{ label: first?.type === "step" ? first.label.text : `#${index + 1}`, body }];
      });
      out.push({
        type: "parallel",
        id: `${scope.prefix}${this.site(call)}`,
        line: this.source.line(call),
        label: { text: "At the same time", dynamic: false },
        branches,
      });
      return true;
    }
    return false;
  }

  private helperCall(
    call: CallExpression,
    name: string,
    receiver: Extract<Node, { type: "Identifier" }>,
    scope: Scope,
    context: string | null,
    out: WorkflowNode[],
  ) {
    const helper = scope.helpers.get(name);
    const param = helper ? firstParamName(helper) : null;
    if (!helper || !param) {
      this.source.error(
        receiver,
        `${name} isn't a helper defined in this file, so the steps it runs can't be shown.`,
        "Define helpers in this file as async function name(w, …) { … } and call them as await name(w, …).",
      );
      return;
    }
    if (context) {
      this.source.error(call, `Steps can't run ${context}.`, CALLBACK_HINT);
      return;
    }
    if (scope.helperStack.includes(name)) {
      this.source.error(call, `${name} calls itself; recursive helpers can't be drawn.`);
      return;
    }
    if (receiver.name !== scope.receivers.at(-1)) {
      this.source.error(
        receiver,
        `Pass ${scope.receivers.at(-1)}, the receiver this callback gets, instead of ${receiver.name}.`,
        CALLBACK_HINT,
      );
      return;
    }
    const site = this.site(call);
    this.edits.set(`frame:${receiver.start}`, {
      start: receiver.start,
      end: receiver.end,
      text: `${receiver.name}.$frame(${JSON.stringify(site)})`,
    });
    for (const argument of call.arguments.slice(1)) this.scan(argument, scope, null, out);
    const repeated = this.inlined.has(helper);
    this.inlined.add(helper);
    if (repeated) this.repeatedHelpers++;
    try {
      out.push(
        ...this.functionBody(helper, {
          ...scope,
          receivers: [...scope.receivers, param],
          prefix: `${scope.prefix}${site}/`,
          exit: "helper",
          inRepeat: false,
          deciders: new Map(),
          helperStack: [...scope.helperStack, name],
        }),
      );
    } finally {
      if (repeated) this.repeatedHelpers--;
    }
  }

  private step(call: CallExpression, verb: WorkflowStepVerb, scope: Scope, out: WorkflowNode[]) {
    const site = this.site(call);
    const label = this.label(call);
    const runTarget = verb === "run" ? this.runTarget(call) : null;
    for (const argument of call.arguments.slice(verb === "run" ? 2 : 1))
      this.scan(argument, scope, null, out);
    const detail = readStepDetail(this.source, verb, call);
    this.tagSite(call, site);
    if (!label || !detail || (verb === "run" && !runTarget)) return;
    if (detail.outcomes && detail.decision !== null) {
      this.decisions.set(`${scope.prefix}${site}`, detail.decision ?? "value");
    }
    out.push({
      type: "step",
      id: `${scope.prefix}${site}`,
      line: this.source.line(call),
      verb,
      label,
      ...(detail.service ? { service: detail.service } : {}),
      detail: runTarget ? { function: { literal: runTarget } } : detail.detail,
      ...(detail.outcomes ? { outcomes: detail.outcomes } : {}),
    });
  }

  /** `w.run(label, fn, …args)`: `fn` must be a top-level function, which runs outside the sandbox. */
  private runTarget(call: CallExpression) {
    const target = call.arguments[1] ? unwrap(call.arguments[1]) : null;
    if (target?.type !== "Identifier" || !this.moduleFunctions.has(target.name)) {
      this.source.error(
        target ?? call,
        "w.run needs a function declared at the top level of this file.",
        RUN_HINT,
      );
      return null;
    }
    this.runFunctions.add(target.name);
    this.edits.set(`run:${target.start}`, {
      start: target.start,
      end: target.end,
      text: JSON.stringify(target.name),
    });
    return target.name;
  }

  /** The callback a loop or parallel branch runs, with its receiver parameter. */
  private callback(node: Node | undefined, call: CallExpression, example: string) {
    const fn = node ? unwrap(node) : undefined;
    const param = isFunction(fn) ? firstParamName(fn) : null;
    if (!isFunction(fn) || !param) {
      this.source.error(
        node ?? call,
        "This needs a callback that takes the receiver first.",
        example,
      );
      return null;
    }
    return { fn, param };
  }

  private loop(call: CallExpression, verb: "each" | "repeat", scope: Scope, out: WorkflowNode[]) {
    const site = this.site(call);
    const label = this.label(call);
    const args = call.arguments;
    const example =
      verb === "each"
        ? 'await w.each("Each issue", issues, async (w, issue) => { … })'
        : 'await w.repeat("Review until clean", { max: 3 }, async (w, attempt) => { … })';
    const callback = this.callback(args.at(-1), call, example);
    let max: number | null | "invalid" = null;
    let concurrency: number | null | "invalid" = null;

    if (verb === "each") {
      if (args.length < 3)
        this.source.error(call, "w.each needs a label, the items, and a callback.", example);
      else this.scan(args[1], scope, null, out);
      const options = args.length >= 4 ? objectProperties(args[2]!) : null;
      concurrency = readPositiveInt(this.source, options?.get("concurrency"), "concurrency", 50);
    } else {
      const options = args.length >= 3 ? objectProperties(args[1]!) : null;
      max = readPositiveInt(this.source, options?.get("max"), "max", 100);
      if (max === null)
        this.source.error(call, "w.repeat needs a max number of attempts.", example);
    }
    this.tagSite(call, site);
    if (!callback) return;
    const body = this.functionBody(callback.fn, {
      ...scope,
      receivers: [...scope.receivers, callback.param],
      prefix: `${scope.prefix}${site}/`,
      exit: "callback",
      inRepeat: verb === "repeat",
      deciders: new Map(scope.deciders),
    });
    if (!label || max === "invalid" || concurrency === "invalid") return;
    out.push({
      type: "loop",
      id: `${scope.prefix}${site}`,
      line: this.source.line(call),
      verb,
      label,
      ...(max !== null ? { max } : {}),
      ...(concurrency !== null ? { concurrency } : {}),
      body,
    });
  }

  private parallel(call: CallExpression, scope: Scope, out: WorkflowNode[]) {
    const site = this.site(call);
    const label = this.label(call);
    const example =
      'await w.parallel("Gather context", { mail: async (w) => …, calendar: async (w) => … })';
    const branches = call.arguments[1] ? unwrap(call.arguments[1]) : null;
    this.tagSite(call, site);
    if (branches?.type !== "ObjectExpression") {
      this.source.error(call, "w.parallel needs an object of named callbacks.", example);
      return;
    }
    const arms: WorkflowArm[] = [];
    for (const property of branches.properties) {
      const key = propertyKey(property);
      if (key === null || !SAFE_KEY.test(key) || property.type !== "Property") {
        this.source.error(property, "Name each parallel branch with a plain identifier.", example);
        continue;
      }
      const callback = this.callback(property.value, call, example);
      if (!callback) continue;
      arms.push({
        label: key,
        body: this.functionBody(callback.fn, {
          ...scope,
          receivers: [...scope.receivers, callback.param],
          prefix: `${scope.prefix}${site}.${key}/`,
          exit: "callback",
          inRepeat: false,
          deciders: new Map(scope.deciders),
        }),
      });
    }
    if (!label) return;
    out.push({
      type: "parallel",
      id: `${scope.prefix}${site}`,
      line: this.source.line(call),
      label,
      branches: arms,
    });
  }
}
