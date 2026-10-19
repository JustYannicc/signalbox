import { parse as protectedParse } from "./parser.js";
import * as primordials from "./interpreter-primordials.js";

const iterator = function () {
  const list = this;
  let index = 0;
  return {
    next() {
      return index < list.length ? { value: list[index++], done: false } : { done: true };
    },
  };
};

// Nimbus's host AST walker iterates Acorn lists. The protected parser deliberately
// returns lists without an iterator. Add a private iterator, leaving its parser,
// node fields, syntax checks and pinned factory/walker bodies unchanged.
function iterableLists(value) {
  if (typeof value !== "object" || value === null) return value;
  if (primordials.arrayIsArray(value)) {
    primordials.reflectDefineProperty(value, primordials.symbolIterator, { value: iterator });
    for (let index = 0; index < value.length; index++) iterableLists(value[index]);
  } else {
    const keys = primordials.objectKeys(value);
    for (let index = 0; index < keys.length; index++) iterableLists(value[keys[index]]);
  }
  return value;
}

export function parse(source, options) {
  return iterableLists(protectedParse(source, options));
}
