export class NodeGeneratedCodeUnavailableError extends Error {
  readonly code = "ERR_NODE_GENERATED_CODE_UNAVAILABLE";

  constructor() {
    super("Node generated-code binding is unavailable");
    this.name = "NodeGeneratedCodeUnavailableError";
  }
}

export class NodeGeneratedCodeRuntimeUnavailableError extends Error {
  readonly code = "ERR_NODE_GENERATED_CODE_RUNTIME_UNAVAILABLE";

  constructor() {
    super("Nimbus generated-function runtime is unavailable");
    this.name = "NodeGeneratedCodeRuntimeUnavailableError";
  }
}

export class NodeGeneratedCodeInputError extends TypeError {
  readonly code = "ERR_NODE_GENERATED_CODE_INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "NodeGeneratedCodeInputError";
  }
}

export class NodeGeneratedCodeIntegrityError extends Error {
  readonly code = "ERR_NODE_GENERATED_CODE_INTEGRITY";
  readonly key: string;

  constructor(key: string) {
    super(`Stored generated-code source failed its integrity check: ${key}`);
    this.name = "NodeGeneratedCodeIntegrityError";
    this.key = key;
  }
}
