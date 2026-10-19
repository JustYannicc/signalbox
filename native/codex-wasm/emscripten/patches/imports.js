// Emscripten's JS linker needs declarations even for wasm_import_module imports.
// The loader supplies these from the request's host; these stubs fail if reached.
addToLibrary({
  runtime_require: function () {
    throw new Error("Missing Emscripten runtime host");
  },
  reactor_new: function () {
    throw new Error("Missing Emscripten reactor host");
  },
  reactor_drop: function () {
    throw new Error("Missing Emscripten reactor host");
  },
  reactor_wake: function () {
    throw new Error("Missing Emscripten reactor host");
  },
  reactor_poll: function () {
    throw new Error("Missing Emscripten reactor host");
  },
});
