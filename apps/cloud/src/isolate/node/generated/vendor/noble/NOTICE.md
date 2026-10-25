# Noble SHA-256

Extracted from the already declared `@noble/hashes` 1.8.0 dependency, MIT, Paul Miller.
Only the SHA-256 declaration closure is retained. Declaration bodies are unchanged apart from repository formatting; exports/imports are replaced by one private entry and captured builtin bindings. The private entry accepts copied byte arrays, so the upstream string-conversion and clone methods are not called. `Hash` loses its Object prototype and all private class prototypes are frozen before guest execution. No runtime source evaluation.

Source files and retained declarations:

- `esm/utils.js`, SHA-256 `4cf4c1e05affedcb4fd584a43d76ae1a3711e34a36e2251b90c27e33ecc74fad`: `isBytes`, `abytes`, `aexists`, `aoutput`, `clean`, `createView`, `rotr`, `utf8ToBytes`, `toBytes`, `Hash`.
- `esm/_md.js`, SHA-256 `cefb1557e7715cb2117c83f82ef3e3175c7e0391c80bd5795b2d4effc45fc582`: `setBigUint64`, `Chi`, `Maj`, `HashMD`, `SHA256_IV`.
- `esm/sha2.js`, SHA-256 `e729088b82e5450bff54c3a0013582aa42e1fe8f58dd31f5967f6ebe34c52299`: `SHA256_K`, `SHA256_W`, `SHA256`.
