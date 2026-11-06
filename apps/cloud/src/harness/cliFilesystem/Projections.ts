interface Mark {
  readonly seq: number;
  /** Computer changed the bytes behind the view, so cached content is not the CLI's own. */
  readonly remote: boolean;
}

export type CliProjectionSnapshot = ReadonlyMap<string, Mark>;

/** Paths the CLI changed whose view state Computer has not yet confirmed. */
export class CliProjections {
  readonly #paths = new Map<string, Mark>();
  /** Bumps only when the CLI changed a path's bytes, not its metadata. */
  readonly #content = new Map<string, number>();
  #seq = 0;

  get size() {
    return this.#paths.size;
  }
  get paths() {
    return [...this.#paths.keys()];
  }
  touch(path: string, remote = false) {
    const previous = this.#paths.get(path);
    this.#paths.set(path, { seq: ++this.#seq, remote: remote || previous?.remote === true });
  }
  touchContent(path: string) {
    this.touch(path);
    this.#content.set(path, this.#seq);
  }
  contentSeq(path: string) {
    return this.#content.get(path);
  }
  /** The CLI wrote this view state itself, so a newer Computer read can't be older than it. */
  projected(path: string) {
    const mark = this.#paths.get(path);
    return mark !== undefined && !mark.remote;
  }
  seq(path: string) {
    return this.#paths.get(path)?.seq;
  }
  snapshot(): CliProjectionSnapshot {
    return new Map(this.#paths);
  }
  /** Reads taken after `snapshot` would overwrite this path's newer projection. */
  movedSince(snapshot: CliProjectionSnapshot, path: string) {
    return this.#paths.get(path)?.seq !== snapshot.get(path)?.seq;
  }
  settle(snapshot: CliProjectionSnapshot) {
    for (const [path, mark] of snapshot)
      if (this.#paths.get(path)?.seq === mark.seq) {
        this.#paths.delete(path);
        this.#content.delete(path);
      }
  }
}
