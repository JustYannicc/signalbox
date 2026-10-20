import * as NodeStringDecoder from "node:string_decoder";

export class LineFramer {
  readonly #decoder = new NodeStringDecoder.StringDecoder("utf8");
  readonly #crlfDelay: number;
  #buffer = "";
  #carriageReturnAt: number | undefined;

  constructor(crlfDelay: number) {
    this.#crlfDelay = crlfDelay;
  }

  write(chunk: string | Uint8Array): string[] {
    return this.#split(typeof chunk === "string" ? chunk : this.#decoder.write(chunk));
  }

  end(): string[] {
    // Node readline discards an incomplete final UTF-8 code point at EOF.
    const lines: string[] = [];
    if (this.#buffer.length > 0) lines.push(this.#buffer);
    this.#buffer = "";
    return lines;
  }

  #split(text: string): string[] {
    const lines: string[] = [];
    if (text.length === 0) return lines;
    let offset = 0;
    const now = performance.now();
    if (this.#carriageReturnAt !== undefined) {
      if (text[0] === "\n" && now - this.#carriageReturnAt <= this.#crlfDelay) offset = 1;
      this.#carriageReturnAt = undefined;
    }
    for (let index = offset; index < text.length; index++) {
      const character = text[index];
      if (
        character !== "\r" &&
        character !== "\n" &&
        character !== "\u2028" &&
        character !== "\u2029"
      )
        continue;
      lines.push(this.#buffer + text.slice(offset, index));
      this.#buffer = "";
      if (character === "\r") {
        if (text[index + 1] === "\n") index++;
        else if (index === text.length - 1) this.#carriageReturnAt = now;
      }
      offset = index + 1;
    }
    this.#buffer += text.slice(offset);
    return lines;
  }
}
