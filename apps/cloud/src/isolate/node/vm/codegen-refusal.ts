const apply = Reflect.apply;
const get = Reflect.get;
const includes = String.prototype.includes;
const CODEGEN_REFUSAL_TEXT = "Code generation from strings disallowed";

export function isCodegenRefusal(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return false;
  if (get(error, "code") === "ERR_METHOD_NOT_IMPLEMENTED") return true;
  const name = get(error, "name");
  const message = get(error, "message");
  return (
    name === "EvalError" &&
    typeof message === "string" &&
    (apply(includes, message, [CODEGEN_REFUSAL_TEXT]) as boolean)
  );
}
