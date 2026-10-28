import { RpcError } from "../CodexExecProtocol.ts";

type Token =
  | { kind: "literal"; value: string }
  | { kind: "any" | "star" | "recursivePrefix" | "recursiveSuffix" | "recursiveZeroOrMore" }
  | { kind: "class"; negated: boolean; ranges: readonly (readonly [string, string])[] }
  | { kind: "alternates"; branches: readonly (readonly Token[])[] };

export function compileSandboxDenyGlobPattern(pattern: string) {
  const parsed = new GlobParser(pattern).parse();
  return { firstGlobIndex: parsed.firstGlobIndex, matcher: compile(parsed.tokens, pattern) };
}

class GlobParser {
  readonly pattern: string;
  #index = 0;
  #previous: string | undefined;
  #current: string | undefined;
  #branches: Token[][] = [[]];
  #alternateStarts: number[] = [];
  #foundUnclosedClass = false;
  #firstGlobIndex: number | undefined;

  constructor(pattern: string) {
    this.pattern = pattern;
  }

  parse(): { tokens: readonly Token[]; firstGlobIndex: number | undefined } {
    let char: string | undefined;
    while ((char = this.#next()) !== undefined) {
      const start = this.#index - char.length;
      switch (char) {
        case "?":
          this.#markGlob(start);
          this.#push({ kind: "any" });
          break;
        case "*":
          this.#markGlob(start);
          this.#parseStar();
          break;
        case "[":
          this.#markGlob(start);
          if (this.#foundUnclosedClass) this.#push({ kind: "literal", value: char });
          else this.#parseClass();
          break;
        case "{":
          this.#markGlob(start);
          this.#alternateStarts.push(this.#branches.length);
          this.#branches.push([]);
          break;
        case "}":
          this.#popAlternate();
          break;
        case ",":
          if (this.#alternateStarts.length === 0) this.#push({ kind: "literal", value: char });
          else this.#branches.push([]);
          break;
        case "\\":
          this.#parseEscape();
          break;
        default:
          this.#push({ kind: "literal", value: char });
      }
    }
    if (this.#alternateStarts.length > 0) this.#fail("unclosed alternate group; missing '}'");
    return { tokens: this.#branches[0]!, firstGlobIndex: this.#firstGlobIndex };
  }

  #next(): string | undefined {
    if (this.#index >= this.pattern.length) return undefined;
    this.#previous = this.#current;
    this.#current = String.fromCodePoint(this.pattern.codePointAt(this.#index)!);
    this.#index += this.#current.length;
    return this.#current;
  }

  #peek(): string | undefined {
    return this.#index >= this.pattern.length
      ? undefined
      : String.fromCodePoint(this.pattern.codePointAt(this.#index)!);
  }

  #parseEscape(): void {
    if (this.#next() === undefined) this.#fail("dangling '\\'");
    this.#push({ kind: "literal", value: this.#current! });
  }

  #parseStar(): void {
    const previous = this.#previous;
    if (this.#peek() !== "*") {
      this.#push({ kind: "star" });
      return;
    }
    this.#next();
    if (this.#branch().length === 0) {
      if (this.#peek() !== undefined && this.#peek() !== "/") {
        this.#push({ kind: "star" });
        this.#push({ kind: "star" });
      } else {
        this.#push({ kind: "recursivePrefix" });
        if (this.#peek() === "/") this.#next();
      }
      return;
    }
    if (
      previous !== "/" &&
      (this.#branches.length <= 1 || (previous !== "," && previous !== "{"))
    ) {
      this.#push({ kind: "star" });
      this.#push({ kind: "star" });
      return;
    }
    let suffix: boolean;
    if (
      this.#peek() === undefined ||
      ((this.#peek() === "," || this.#peek() === "}") && this.#branches.length >= 2)
    ) {
      suffix = true;
    } else if (this.#peek() === "/") {
      this.#next();
      suffix = false;
    } else {
      this.#push({ kind: "star" });
      this.#push({ kind: "star" });
      return;
    }
    const previousToken = this.#branch().pop()!;
    if (previousToken.kind === "recursivePrefix" || previousToken.kind === "recursiveSuffix") {
      this.#push(previousToken);
    } else {
      this.#push({ kind: suffix ? "recursiveSuffix" : "recursiveZeroOrMore" });
    }
  }

  #parseClass(): void {
    const saved = { index: this.#index, previous: this.#previous, current: this.#current };
    const negated = this.#peek() === "!" || this.#peek() === "^";
    if (negated) this.#next();
    const ranges: Array<readonly [string, string]> = [];
    let first = true;
    let inRange = false;
    let closed = false;
    for (;;) {
      const char = this.#next();
      if (char === undefined) break;
      if (char === "]") {
        if (first) ranges.push(["]", "]"]);
        else {
          closed = true;
          break;
        }
      } else if (char === "-") {
        if (first) ranges.push(["-", "-"]);
        else if (inRange) {
          const last = ranges.pop()!;
          this.#addRange(ranges, last[0], "-");
          inRange = false;
        } else inRange = true;
      } else if (inRange) {
        this.#addRange(ranges, ranges.pop()![0], char);
        inRange = false;
      } else ranges.push([char, char]);
      first = false;
    }
    if (!closed) {
      this.#index = saved.index;
      this.#previous = saved.previous;
      this.#current = saved.current;
      this.#foundUnclosedClass = true;
      this.#push({ kind: "literal", value: "[" });
      return;
    }
    if (inRange) ranges.push(["-", "-"]);
    this.#push({ kind: "class", negated, ranges });
  }

  #addRange(ranges: Array<readonly [string, string]>, start: string, end: string): void {
    if (start.codePointAt(0)! > end.codePointAt(0)!) {
      this.#fail("invalid range; '" + start + "' > '" + end + "'");
    }
    ranges.push([start, end]);
  }

  #popAlternate(): void {
    const start = this.#alternateStarts.pop();
    if (start === undefined) this.#fail("unopened alternate group; missing '{'");
    this.#push({ kind: "alternates", branches: this.#branches.splice(start) });
  }

  #branch(): Token[] {
    return this.#branches[this.#branches.length - 1]!;
  }
  #push(token: Token): void {
    this.#branch().push(token);
  }
  #markGlob(index: number): void {
    this.#firstGlobIndex ??= index;
  }
  #fail(reason: string): never {
    throw new RpcError(
      -32600,
      "Invalid filesystem deny glob: error parsing glob '" + this.pattern + "': " + reason,
    );
  }
}

function compile(tokens: readonly Token[], pattern: string): RegExp {
  const regex = tokens.map(tokenRegex).join("");
  try {
    return new RegExp("^" + regex + "$(?![\\s\\S])", "su");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "regex compilation failed";
    throw new RpcError(
      -32600,
      "Invalid filesystem deny glob: error parsing glob '" + pattern + "': " + reason,
    );
  }
}

function tokenRegex(token: Token): string {
  switch (token.kind) {
    case "literal":
      return token.value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    case "any":
      return "[^/]";
    case "star":
      return "[^/]*";
    case "recursivePrefix":
      return "(?:/?|.*/)";
    case "recursiveSuffix":
      return "/.*";
    case "recursiveZeroOrMore":
      return "(?:/|/.*/)";
    case "class": {
      const ranges = token.ranges
        .map(([start, end]) =>
          start === end ? classLiteral(start) : classLiteral(start) + "-" + classLiteral(end),
        )
        .join("");
      return "[" + (token.negated ? "^" : "") + ranges + "]";
    }
    case "alternates": {
      const alternatives = token.branches
        .map((branch) => branch.map(tokenRegex).join(""))
        .filter(Boolean);
      return alternatives.length === 0 ? "" : "(?:" + alternatives.join("|") + ")";
    }
  }
}

function classLiteral(char: string): string {
  switch (char) {
    case "[":
      return "\\x5b";
    case "\\":
      return "\\x5c";
    case "]":
      return "\\x5d";
    case "^":
      return "\\x5e";
    case "-":
      return "\\x2d";
    default:
      return char;
  }
}
