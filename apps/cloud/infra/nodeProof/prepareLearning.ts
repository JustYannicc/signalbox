// @effect-diagnostics nodeBuiltinImport:off - builds fixtures; the parent owns native execution.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import type { NodeGeneratedCodeModuleMap } from "../../src/isolate/NodeGeneratedCode.ts";
import { NODE_VM_PREPARED_MODULES, prepareNodeVmModules } from "./prepareVm.ts";

/**
 * Cold boot: /status compiles through the real VM and learns into facet SQLite.
 * /prepare?budget=N drains learning and returns the full budgeted map as JSON.
 * Pass that JSON as `prepared` to build a fresh boot with static gen imports.
 * Its /status counts native factory hits and deliberate interpreter paths separately.
 */
export async function prepareNodeVmLearningProof(
  destination: string,
  options: {
    readonly preparedDirectory?: string;
    readonly prepared?: NodeGeneratedCodeModuleMap;
  } = {},
): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  if (options.preparedDirectory) {
    for (const name of Object.values(NODE_VM_PREPARED_MODULES)) {
      const path = NodePath.join(destination, name);
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.copyFile(NodePath.join(options.preparedDirectory, name), path);
    }
  } else {
    await prepareNodeVmModules(destination);
  }
  const modules = options.prepared?.modules ?? {};
  const names = Object.keys(modules).sort();
  for (const name of names) {
    if (!/^gen\/[0-9a-f]{64}\.js$/u.test(name) || typeof modules[name] !== "string") {
      throw new Error(`Invalid prepared learning module: ${name}`);
    }
    const path = NodePath.join(destination, name);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, modules[name]!);
  }
  const bundle = await Esbuild.build({
    stdin: {
      contents: `export {createNodeVm} from './src/isolate/NodeVm.ts';
export {createNodeGeneratedCode,nodeGeneratedCodeGraphDigest} from './src/isolate/NodeGeneratedCode.ts';`,
      resolveDir: NodeURL.fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    platform: "neutral",
    packages: "external",
    target: "es2022",
    format: "esm",
    write: false,
  });
  const runtime = bundle.outputFiles?.[0]?.text;
  if (!runtime) throw new Error("Learning proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "learning-runtime.js"), runtime);
  const phase = options.prepared ? "next" : "cold";
  const imports = names
    .map((name, index) => `import factory${index} from ${JSON.stringify(`./${name}`)};`)
    .join("\n");
  const factories = names.map((name, index) => `${JSON.stringify(name)}:factory${index}`).join(",");
  const main = `import {DurableObject} from 'cloudflare:workers';
import * as nativeVm from 'node:vm';
import * as nativeUtil from 'node:util';
import {createNodeVm,createNodeGeneratedCode,nodeGeneratedCodeGraphDigest} from './learning-runtime.js';
import primordials from './node/vm/interpreter-primordials.js';
import interpreter from './node/vm/interpreter.js';
import hostOps from './node/vm/host-ops.js';
import moduleHelpers from './node/vm/module-helpers.js';
import analysis from './node/vm/expression-analysis.js';
import functionRuntime from './node/vm/function-runtime.js';
${imports}
const phase = ${JSON.stringify(phase)};
const functionIndex = ${JSON.stringify(options.prepared?.functionIndex ?? {})};
const factories = {${factories}};
function assert(value, message) { if (!value) throw new Error(message); }
const runtimeModules = {
  createInterpreter:interpreter.createInterpreter,
  primordials:primordials.LAUNCH_PRIMORDIALS,hostOps,moduleHelpers,
  hasSyntheticArgumentsReference:analysis.hasSyntheticArgumentsReference,
  canStageFunction:analysis.canStageFunction,
};
async function verifyFlushAndRetention(storage) {
  const write = Promise.withResolvers();
  const pendingVm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:{learnFunction(){return write.promise;}}});
  const empty = pendingVm.flushLearning();
  assert(pendingVm.module.compileFunction('return 101')() === 101, 'Pending write changed execution');
  let settled = false;
  const next = pendingVm.flushLearning().then(() => {settled = true;});
  await empty;
  assert(!settled, 'Second flush missed the newly queued write');
  write.resolve();
  await next;
  const failure = new Error('fixture sync persistence failure');
  const failedVm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:{learnFunction(){throw failure;}}});
  const failedEmpty = failedVm.flushLearning();
  failedVm.module.compileFunction('return 103');
  const failedFlush = failedVm.flushLearning().then(() => undefined,error => error);
  await failedEmpty;
  assert((await failedFlush)?.errors[0] === failure, 'Second flush missed synchronous failure');
  const bounded = createNodeGeneratedCode({storage,scopeId:'learning-retention',functionRuntime,
    retention:{maxEntries:1,maxBytes:2048}});
  const boundedVm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:bounded});
  boundedVm.module.compileFunction('return 107');
  boundedVm.module.compileFunction('return 109');
  await boundedVm.flushLearning();
  assert(Object.keys((await bounded.prepare(1048576)).modules).length === 1, 'Entry retention was not bounded');
  assert(Object.keys((await bounded.prepare(0)).modules).length === 0, 'Zero preparation budget was ignored');
  const large = 'x'.repeat(4096);
  assert(boundedVm.module.compileFunction('return '+JSON.stringify(large))() === large, 'Oversize source stopped execution');
  await boundedVm.flushLearning();
  assert(Object.keys((await bounded.prepare(1048576)).modules).length === 1, 'Oversize source evicted useful code');
}
async function verifyLearningPrimordials(storage) {
  const generated = createNodeGeneratedCode({storage,scopeId:'learning-primordials',functionRuntime});
  const vm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:generated});
  const define = Object.defineProperty;
  const keys = ['includes','push',Symbol.iterator];
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(Array.prototype,key));
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('Replaced array helper ran during cold normalization'); };
  const shared = {value:17};
  let scalar,identity;
  try {
    for (let index = 0; index < keys.length; index++) {
      define(Array.prototype,keys[index],{value:unexpected,configurable:true,writable:true});
    }
    scalar = vm.module.compileFunction('return 1')();
    identity = vm.functionConstructors.Function('value','return value')(shared);
  } finally {
    for (let index = 0; index < keys.length; index++) define(Array.prototype,keys[index],descriptors[index]);
  }
  await vm.flushLearning();
  const map = await generated.prepare(1048576);
  assert(calls === 0 && scalar === 1 && identity === shared && Object.keys(map.modules).length === 2,
    'Cold normalization invoked a guest hook or failed to persist');
  const replacements = [[Array,'from'],[Array.prototype,'join'],[Number.prototype,'toString'],[String.prototype,'padStart'],[Object.getPrototypeOf(Uint8Array.prototype),Symbol.iterator]];
  const previous = replacements.map(([object,key]) => Object.getOwnPropertyDescriptor(object,key));
  let hash;
  try {
    for (let index = 0; index < replacements.length; index++) {
      const [object,key] = replacements[index];
      define(object,key,{value:unexpected,configurable:true,writable:true});
    }
    hash = await nodeGeneratedCodeGraphDigest({mainModule:'main.js',modules:{'main.js':"module.exports = 'Grüezi 😀';"}});
  } finally {
    for (let index = 0; index < replacements.length; index++) {
      const [object,key] = replacements[index];
      define(object,key,previous[index]);
    }
  }
  assert(calls === 0 && hash === '2eebb7b2eeb3ca962fff113e598ba0a23f70222b034f5c0bec0d52f8939bd71c',
    'Hash conversion invoked a guest hook or changed digest bytes');
}
async function verifyPersistentLearningHooks(storage) {
  const generated = createNodeGeneratedCode({storage,scopeId:'learning-persistent-'+crypto.randomUUID(),functionRuntime});
  const vm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:generated});
  const define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor;
  const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]());
  const replacements = [
    [Array.prototype,Symbol.iterator],[arrayIterator,'next'],[Array.prototype,'map'],
    [Array.prototype,'sort'],[Array.prototype,'push'],[Array.prototype,'join'],
    [Set.prototype,'add'],[Set.prototype,'has'],[Object,'keys'],[String.prototype,'slice'],
    [Reflect,'get'],[Array,'isArray'],[Array,'from'],[JSON,'stringify'],
    [TextEncoder.prototype,'encode'],[Number,'isSafeInteger'],[Math,'min'],
  ];
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('Persistent guest hook ran during learning'); };
  const shared = {value:17};
  for (let index = 0; index < replacements.length; index++) {
    const target = replacements[index][0];
    const key = replacements[index][1];
    const descriptor = own(target,key);
    let scalar,identity;
    try {
      define(target,key,{value:unexpected,writable:true,configurable:true});
      scalar = vm.module.compileFunction('return 1')();
      identity = vm.functionConstructors.Function('value','return value')(shared);
      await vm.flushLearning();
    } finally {
      define(target,key,descriptor);
    }
    assert(calls === 0 && scalar === 1 && identity === shared, 'Persistent replacement changed execution or ran a hook');
    assert(Object.keys((await generated.prepare(1048576)).modules).length === 0, 'Unsafe realm retained a function');
  }
  const descriptor = own(Array.prototype,'map');
  try {
    define(Array.prototype,'map',{get:unexpected,configurable:true});
    assert(vm.module.compileFunction('return 1')() === 1, 'Accessor replacement stopped compilation');
    await vm.flushLearning();
  } finally { define(Array.prototype,'map',descriptor); }
  const binding = own(globalThis,'Set');
  const proxy = new Proxy(Set,{get:unexpected,getOwnPropertyDescriptor:unexpected,getPrototypeOf:unexpected});
  try {
    define(globalThis,'Set',{value:proxy,writable:true,configurable:true});
    vm.module.compileFunction('return 1');
    await vm.flushLearning();
  } finally { define(globalThis,'Set',binding); }
  assert(calls === 0 && Object.keys((await generated.prepare(1048576)).modules).length === 0, 'Guard invoked an accessor/Proxy or retained unsafe code');
  vm.module.compileFunction('return 1');
  vm.functionConstructors.Function('value','return value')(shared);
  await vm.flushLearning();
  assert(Object.keys((await generated.prepare(1048576)).modules).length === 2, 'Learning did not recover after restoring the realm');
  const built = Promise.withResolvers();
  const duringHash = createNodeGeneratedCode({storage,scopeId:'learning-post-hash-'+crypto.randomUUID(),functionRuntime:{
    runtimeFunctionModule(...input) {
      const source = functionRuntime.runtimeFunctionModule(...input);
      built.resolve();
      return source;
    },
  }});
  const secondVm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:duringHash});
  secondVm.module.compileFunction('return 1');
  await built.promise;
  const push = own(Array.prototype,'push');
  try {
    define(Array.prototype,'push',{value:unexpected,writable:true,configurable:true});
    await secondVm.flushLearning();
  } finally { define(Array.prototype,'push',push); }
  assert(calls === 0 && Object.keys((await duringHash.prepare(1048576)).modules).length === 0, 'Post-hash continuation ran a hook or persisted unsafe code');
}
async function verifyPersistentByteLength(storage) {
  const generated = createNodeGeneratedCode({storage,scopeId:'learning-byte-length-'+crypto.randomUUID(),functionRuntime});
  const vm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:generated});
  const target = Object.getPrototypeOf(Uint8Array.prototype);
  const own = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const descriptor = own(target,'byteLength');
  let calls = 0;
  let map;
  try {
    define(target,'byteLength',{get(){calls++;throw new Error('Guest byteLength ran');},configurable:true});
    assert(vm.module.compileFunction('return 1')() === 1, 'ByteLength hook changed execution');
    vm.functionConstructors.Function('value','return value')(17);
    await vm.flushLearning();
    map = await generated.prepare(1048576);
  } finally { define(target,'byteLength',descriptor); }
  assert(calls === 0 && Object.keys(map.modules).length === 2, 'ByteLength hook ran or prevented legitimate retention');
}
async function verifyHashHelpers(storage) {
  const generated = createNodeGeneratedCode({storage,scopeId:'hash-helpers-'+crypto.randomUUID(),functionRuntime});
  const define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor;
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const targets = [
    [Object,'getPrototypeOf'],[Object,'getOwnPropertyDescriptor'],[Reflect,'apply'],
    [Array,'from'],[Array.prototype,Symbol.iterator],[Math,'min'],[TextEncoder.prototype,'encode'],
    [typed,'buffer'],[typed,'byteLength'],[typed,'byteOffset'],[typed,'length'],
    [typed,Symbol.iterator],[typed,'set'],[typed,'subarray'],[typed,'fill'],
    [DataView.prototype,'getUint32'],[DataView.prototype,'setUint32'],[DataView.prototype,'setBigUint64'],
    [Object.prototype,'then'],[Object.prototype,'A'],
  ];
  const descriptors = targets.map(([target,key]) => own(target,key));
  let calls = 0;
  const unexpected = () => {calls++;throw new Error('Guest hash helper ran');};
  let key;
  try {
    for(let index=0;index<targets.length;index++){
      const target = targets[index][0];const name = targets[index][1];
      define(target,name,{get:unexpected,configurable:true});
    }
    key = await generated.learnFunction({kind:'function',params:[],body:'return 1'});
  }finally{
    for(let index=0;index<targets.length;index++){
      const target = targets[index][0];const name = targets[index][1];
      if(descriptors[index])define(target,name,descriptors[index]);else delete target[name];
    }
  }
  assert(calls === 0 && key === '8656061100a46451d3d55a3c6942c9e591ae650a0afc94b1095ce6d58f433d45',
    'Persistent guest helpers ran or forged the SHA-256 key');
  assert(Object.keys((await generated.prepare(1048576)).modules).length === 0, 'Unsafe hash realm retained source');
  await generated.learnFunction({kind:'function',params:[],body:'return 1'});
  assert(Object.keys((await generated.prepare(1048576)).modules).length === 1, 'Hash learning did not recover');
}
async function verifyPersistentPromiseHooks(storage) {
  // Attach the caller's await before changing the shared realm's Promise surface.
  await undefined;
  const generated = createNodeGeneratedCode({storage,scopeId:'learning-promise-'+crypto.randomUUID(),functionRuntime});
  const vm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:generated});
  const define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply;
  const nativeThen = Promise.prototype.then;
  const targets = [Promise.prototype,Promise.prototype,Promise];
  const names = ['constructor','then',Symbol.species];
  const originals = targets.map((target,index) => own(target,names[index]));
  let calls = 0;
  const fail = () => {calls++;throw new Error('Guest Promise hook ran');};
  const forge = function(ok,error) {calls++;return apply(nativeThen,this,[() => ok('forged'),error]);};
  vm.module.compileFunction('return 1');
  await vm.flushLearning();
  const original = await generated.prepare(1048576);
  const originalKey = Object.keys(original.modules)[0];
  for (let index = 0; index < 4; index++) {
    try {
      if (index === 0) define(Promise.prototype,'constructor',{get:fail,configurable:true});
      if (index === 1) define(Promise.prototype,'then',{value:forge,writable:true,configurable:true});
      if (index === 2) define(Promise,Symbol.species,{get:fail,configurable:true});
      if (index === 3) {
        define(Promise.prototype,'constructor',{value:function X(){},writable:true,configurable:true});
        define(Promise.prototype,'then',{value:forge,writable:true,configurable:true});
        define(Promise,Symbol.species,{get:fail,configurable:true});
      }
      assert(vm.module.compileFunction('return 2')() === 2, 'Promise hooks changed compilation');
      await vm.flushLearning();
      const staged = await generated.prepare(1048576);
      assert(Object.keys(staged.modules).length === 1 && staged.modules[originalKey] === original.modules[originalKey],
        'Promise hooks corrupted source/keys or retained unsafe code');
    } finally {
      for (let field = 0; field < targets.length; field++) define(targets[field],names[field],originals[field]);
    }
  }
  vm.module.compileFunction('return 2');
  await vm.flushLearning();
  assert(calls === 0 && Object.keys((await generated.prepare(1048576)).modules).length === 2,
    'Promise hook ran or learning did not recover');
}
async function verifyLearningQueueSetters() {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const third = Promise.withResolvers();
  const failures = [new Error('first learner'),new Error('second learner'),new Error('third learner'),new Error('sync learner')];
  let writes = 0;
  const vm = createNodeVm(nativeVm,runtimeModules,undefined,{learning:{learnFunction(){
    writes++;
    if(writes === 1)return first.promise;
    if(writes === 2)return second.promise;
    if(writes === 3)return third.promise;
    throw failures[3];
  }}});
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype,'0');
  const lengthDescriptor = Object.getOwnPropertyDescriptor(Array.prototype,'length');
  let hooks = 0;
  let firstError,nextError,shared;
  try {
    define(Array.prototype,'0',{set(){hooks++;},configurable:true});
    vm.module.compileFunction('return 1');
    const pending = vm.flushLearning();
    vm.module.compileFunction('return 2');
    shared = vm.flushLearning() === pending;
    first.reject(failures[0]);second.reject(failures[1]);
    firstError = await pending.then(() => undefined,error => error);
    vm.module.compileFunction('return 3');
    vm.module.compileFunction('return 4');
    const next = vm.flushLearning();
    third.reject(failures[2]);
    nextError = await next.then(() => undefined,error => error);
  } finally {
    if(descriptor)define(Array.prototype,'0',descriptor);else delete Array.prototype[0];
    define(Array.prototype,'length',lengthDescriptor);
  }
  assert(hooks === 0 && shared && firstError?.errors.length === 2 && firstError.errors[0] === failures[0] && firstError.errors[1] === failures[1],
    'Inherited setter ran or concurrent flush lost rejected learners');
  assert(nextError?.errors.length === 2 && nextError.errors[0] === failures[3] && nextError.errors[1] === failures[2],
    'Reset learning queues lost asynchronous or synchronous failures');
}
async function verifyPreparationHooks(storage) {
  let chunkRead;
  const observedStorage = {
    sql:{databaseSize:storage.sql.databaseSize,exec(query,...bindings){
      const result = storage.sql.exec(query,...bindings);
      if(chunkRead && query.includes('FROM node_generated_code_chunk_v1')){const notify=chunkRead;chunkRead=undefined;notify();}
      return result;
    }},
    transactionSync:callback => storage.transactionSync(callback),
  };
  const scopeId = 'prepare-hooks-'+crypto.randomUUID();
  const generated = createNodeGeneratedCode({storage:observedStorage,scopeId,functionRuntime});
  await generated.learnFunction({kind:'function',params:[],body:'return 1'});
  await generated.learnFunction({kind:'function',params:[],body:'return 2'});
  const original = await generated.prepare(1048576);
  const keys = Object.keys(original.modules).sort().join(',');
  const define = Object.defineProperty;
  const own = Object.getOwnPropertyDescriptor;
  const prototypeOf = Object.getPrototypeOf;
  const from = own(Array,'from');
  const then = own(Object.prototype,'then');
  let hooks = 0;
  let nullRoots = prototypeOf(original) === null;
  const replacement = () => {hooks++;return [];};
  const getter = () => {hooks++;throw new Error('Inherited prepared-result then was read');};
  for(let index=0;index<6;index++){
    let pending;
    try {
      if(index >= 4){
        const read = Promise.withResolvers();chunkRead=read.resolve;
        pending = generated.prepare(1048576);
        await read.promise;
      }else if(index >= 2)pending = generated.prepare(1048576);
      if(index % 2 === 0)define(Array,'from',{value:replacement,writable:true,configurable:true});
      else define(Object.prototype,'then',{get:getter,configurable:true});
      const prepared = await (pending ?? generated.prepare(1048576));
      nullRoots = nullRoots && prototypeOf(prepared) === null;
      const retained = storage.sql.exec('SELECT count(*) AS n FROM node_generated_code_retention_v1 WHERE scope_id = ?',scopeId).one().n;
      assert(retained === 2, 'Unsafe preparation deleted valid retained rows');
    } finally {
      define(Array,'from',from);
      if(then)define(Object.prototype,'then',then);else delete Object.prototype.then;
    }
    const recovered = await generated.prepare(1048576);
    assert(Object.keys(recovered.modules).sort().join(',') === keys, 'Retained source did not recover after preparation hooks');
  }
  assert(hooks === 0 && nullRoots, 'Preparation ran a guest helper or returned an inherited thenable');
}
function verifyStagedCjsAccessors(vm) {
  const names = ['require','module','exports','__filename','__dirname'];
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis,name));
  const inherited = Object.getPrototypeOf(globalThis);
  const previousInherited = names.map(name => Object.getOwnPropertyDescriptor(inherited,name));
  let reads = 0;
  const getter = () => { reads++; throw new Error('Unrelated CJS accessor was invoked'); };
  try {
    assert(vm.module.compileFunction('return 1')() === 1, 'Safe staged function failed');
    for (const name of names) {
      Object.defineProperty(globalThis,name,{get:getter,configurable:true});
      assert(vm.functionConstructors.Function('return 1')() === 1, 'Own CJS accessor changed construction');
      Object.defineProperty(globalThis,name,{value:7,writable:true,configurable:true});
      assert(vm.module.compileFunction('return 1')() === 1, 'Replaced own accessor remained cached');
      delete globalThis[name];
      Object.defineProperty(inherited,name,{get:getter,configurable:true});
      assert(vm.module.compileFunction('return 1')() === 1, 'Inherited CJS accessor changed construction');
      Object.defineProperty(globalThis,name,{value:11,writable:true,configurable:true});
      assert(vm.functionConstructors.Function('return 1')() === 1, 'Own data did not shadow inherited accessor');
    }
    assert(reads === 0, 'Accessor inspection invoked a getter');
  } finally {
    names.forEach((name,index) => {
      if (previousInherited[index]) Object.defineProperty(inherited,name,previousInherited[index]);
      else delete inherited[name];
      if (previous[index]) Object.defineProperty(globalThis,name,previous[index]);
      else delete globalThis[name];
    });
  }
}
function verifyStagedGlobalGuards(vm) {
  const root = globalThis;
  const own = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const proto = Object.getPrototypeOf;
  const setProto = Object.setPrototypeOf;
  const binding = own(root,'globalThis');
  const inherited = proto(root);
  const previousPrototype = proto(inherited);
  const names = ['require','module','exports','__filename','__dirname'];
  const previous = names.map(name => own(root,name));
  const previousInherited = names.map(name => own(inherited,name));
  let traps = 0;
  let reads = 0;
  const unexpectedTrap = () => { traps++; throw new Error('Global Proxy trap ran'); };
  const unexpectedRead = () => { reads++; throw new Error('Global binding getter ran'); };
  const target = Object.create(previousPrototype);
  const proxy = new Proxy(target,{get:unexpectedTrap,getOwnPropertyDescriptor:unexpectedTrap,getPrototypeOf:unexpectedTrap});
  const revoked = Proxy.revocable(target,{});
  revoked.revoke();
  const isProxy = nativeUtil.types.isProxy;
  assert(typeof isProxy === 'function', 'Native Proxy detector unavailable');
  assert(!isProxy(root) && !isProxy(target) && isProxy(proxy) && isProxy(revoked.proxy) && traps === 0, 'Native Proxy detector invoked traps or misidentified values');
  try {
    const decoy = Object.create(null,{require:{get:unexpectedRead}});
    for (const value of [null,decoy,proxy,revoked.proxy]) {
      define(root,'globalThis',{value,writable:true,configurable:true});
      assert(vm.module.compileFunction('return 1')() === 1, 'Replaced globalThis binding changed construction');
    }
    define(root,'globalThis',{get:unexpectedRead,configurable:true});
    assert(vm.functionConstructors.Function('return 1')() === 1, 'globalThis accessor changed construction');
    define(root,'globalThis',binding);
    assert(vm.module.compileFunction('return 1')() === 1, 'Restored globalThis did not stage');
    for (const name of names) {
      delete root[name];
      delete inherited[name];
    }
    for (const prototype of [proxy,Object.create(proxy),revoked.proxy]) {
      setProto(inherited,prototype);
      assert(vm.functionConstructors.Function('return 1')() === 1, 'Proxy prototype changed construction');
    }
    setProto(inherited,previousPrototype);
    assert(vm.module.compileFunction('return 1')() === 1, 'Restored prototype did not stage');
    define(root,'require',{value:proxy,writable:true,configurable:true});
    assert(vm.module.compileFunction('return 1')() === 1, 'A Proxy stored as data was inspected');
    const replacements = [[Object,'getOwnPropertyDescriptor'],[Object,'getPrototypeOf'],[Object,'hasOwn'],[nativeUtil.types,'isProxy']];
    const descriptors = replacements.map(([object,name]) => own(object,name));
    let replacementCalls = 0;
    try {
      for (const [object,name] of replacements) {
        define(object,name,{value() { replacementCalls++; throw new Error('Replacement reflection helper ran'); },writable:true,configurable:true});
      }
      assert(vm.module.compileFunction('return 1')() === 1, 'Captured reflection helpers were replaced');
      delete root.require;
      setProto(inherited,proxy);
      assert(vm.functionConstructors.Function('return 1')() === 1, 'Captured Proxy detector was replaced');
    } finally {
      replacements.forEach(([object,name],index) => define(object,name,descriptors[index]));
    }
    assert(replacementCalls === 0 && traps === 0 && reads === 0, 'Global guard executed guest hooks');
  } finally {
    define(root,'globalThis',binding);
    setProto(inherited,previousPrototype);
    names.forEach((name,index) => {
      if (previous[index]) define(root,name,previous[index]);
      else delete root[name];
      if (previousInherited[index]) define(inherited,name,previousInherited[index]);
      else delete inherited[name];
    });
  }
}
async function verifyAnonymousBindings(vm) {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'anonymous');
  try {
    Object.defineProperty(globalThis,'anonymous',{value:23,writable:true,configurable:true});
    assert(vm.module.compileFunction('return anonymous')() === 23, 'anonymous became the function itself');
    const escaped = 'return '+String.fromCharCode(92)+'u0061nonymous';
    assert(vm.functionConstructors.Function(escaped)() === 23, 'Escaped anonymous lookup changed');
    const nested = vm.functionConstructors.Function('return () => anonymous')();
    globalThis.anonymous = 29;
    assert(nested() === 29, 'Nested anonymous lookup stopped following the global');
    assert(vm.functionConstructors.Function('anonymous = 31; return anonymous')() === 31 && globalThis.anonymous === 31, 'anonymous assignment missed the global');
    globalThis.anonymous = 23;
    assert(vm.functionConstructors.Function('value = anonymous','return value')() === 23, 'Parameter default captured the synthetic name');
    assert(await vm.functionConstructors.AsyncFunction('return anonymous')() === 23, 'Async anonymous lookup changed');
    assert(vm.functionConstructors.GeneratorFunction('yield anonymous')().next().value === 23, 'Generator anonymous lookup changed');
    assert((await vm.functionConstructors.AsyncGeneratorFunction('yield anonymous')().next()).value === 23, 'Async generator anonymous lookup changed');
    assert(vm.functionConstructors.Function('anonymous','return anonymous')(41) === 41, 'Shadowed anonymous parameter changed');
    assert(vm.module.compileFunction('let anonymous = 43; return () => anonymous')()() === 43, 'Shadowed anonymous closure changed');
    assert(vm.module.compileFunction('let '+String.fromCharCode(92)+'u0061nonymous = 47; return anonymous')() === 47, 'Escaped local anonymous changed');
    const local = vm.functionConstructors.Function('return function anonymous() { return anonymous; }')();
    assert(local() === local, 'Nested named function lost its own binding');
    assert(vm.module.compileFunction("return ({anonymous: 'anonymous'}).anonymous")() === 'anonymous', 'Property key was treated as a free name');
  } finally {
    if (previous) Object.defineProperty(globalThis,'anonymous',previous);
    else delete globalThis.anonymous;
  }
}
export class NodeVmLearningFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.generated = createNodeGeneratedCode({storage:ctx.storage,scopeId:'node-vm-learning-proof',functionRuntime});
    this.counts = {interpreter:0,native:0};
    const counts = this.counts;
    const modules = {};
    for (const [name, factory] of Object.entries(factories)) {
      const counted = (...args) => { counts.native++; return factory(...args); };
      if (factory.unbound !== undefined) counted.unbound = (...args) => { counts.native++; return factory.unbound(...args); };
      if (factory.source !== undefined) counted.source = factory.source;
      modules[name] = counted;
    }
    this.vm = createNodeVm(nativeVm, {
      ...runtimeModules,
      createInterpreter(...args) {
        const instance = interpreter.createInterpreter(...args);
        return {...instance,compileFunction(...input) {
          counts.interpreter++;
          return instance.compileFunction(...input);
        }};
      },
    }, undefined, {learning:this.generated,
      prepared:{functionIndex,modules,registerSource:primordials.registerSource}});
  }
  async fetch(request) {
    const checks = {};
    const before = {...this.counts};
    try {
      const url = new URL(request.url);
      if (url.pathname === '/prepare') {
        await this.vm.flushLearning();
        const budget = Number(url.searchParams.get('budget') ?? '1048576');
        return Response.json(await this.generated.prepare(budget));
      }
      const vm = this.vm;
      let refused = false;
      try { new Function('return 1'); }
      catch(error) { refused = error.name === 'EvalError'; }
      assert(refused, 'Native request-time string codegen was not refused');
      checks.nativeStringCodegenRefused = true;
      const local = {n:0};
      const body = 'value.n++; return value';
      assert(vm.module.compileFunction(body,['value'])(local) === local, 'VM local identity lost');
      assert(vm.functionConstructors.Function('value',body)(local) === local && local.n === 2, 'Function identity lost');
      checks.localObjectIdentity = true;
      assert(await vm.functionConstructors.AsyncFunction('value','return value')(local) === local, 'Async kind differs');
      assert(vm.functionConstructors.GeneratorFunction('value','yield value')(local).next().value === local, 'Generator kind differs');
      assert((await vm.functionConstructors.AsyncGeneratorFunction('value','yield value')(local).next()).value === local, 'Async generator kind differs');
      checks.functionKinds = true;
      assert(vm.functionConstructors.Function('return this')() === globalThis, 'Sloppy this differs');
      assert(vm.functionConstructors.Function("'use strict'; return this")() === undefined, 'Strict this differs');
      assert(vm.functionConstructors.Function('return Function')() === globalThis.Function, 'Unbound Function origin differs');
      assert(vm.functionConstructors.Function('return typeof require')() === typeof globalThis.require, 'CJS wrapper leaked');
      checks.globalOrigin = true;
      const cjsNames = ['require','module','exports','__filename','__dirname'];
      const previous = cjsNames.map(name => Object.getOwnPropertyDescriptor(globalThis,name));
      try {
        for (const name of cjsNames) {
          Object.defineProperty(globalThis,name,{value:1,writable:true,configurable:true});
          const read = vm.module.compileFunction('return '+name);
          const escapedName = String.fromCharCode(92)+'u'+name.charCodeAt(0).toString(16).padStart(4,'0')+name.slice(1);
          const escaped = vm.functionConstructors.Function('return '+escapedName);
          const nested = vm.functionConstructors.Function('return () => '+name)();
          globalThis[name] = 2;
          assert(read() === 2 && escaped() === 2 && nested() === 2, 'CJS global read captured an old value');
          vm.functionConstructors.Function(name+' = 3')();
          assert(globalThis[name] === 3, 'CJS assignment wrote a captured binding');
          const local = vm.functionConstructors.Function(name,'return '+name);
          assert(local(127) === 127, 'A shadowed CJS name changed behavior');
        }
      } finally {
        cjsNames.forEach((name,index) => {
          if (previous[index]) Object.defineProperty(globalThis,name,previous[index]);
          else delete globalThis[name];
        });
      }
      checks.liveCjsReadsWritesAndShadowing = true;
      verifyStagedCjsAccessors(vm);
      checks.stagedCjsAccessorsNeverRead = true;
      verifyStagedGlobalGuards(vm);
      checks.nativeProxyDetectionAndCapturedGlobalGuards = true;
      await verifyAnonymousBindings(vm);
      checks.anonymousGlobalAndShadowedBindings = true;
      const next = vm.functionConstructors.Function('let n = 0; return () => ++n')();
      assert(next() === 1 && next() === 2, 'Closure state differs');
      checks.closure = true;
      const imports = vm.functionConstructors.Function("return import('node:path')");
      let importError;
      try { await imports(); } catch(error) { importError = error; }
      assert(importError?.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'Dynamic import origin differs');
      assert(imports.toString().includes("import('node:path')"), 'Rewritten import source leaked');
      checks.importOriginAndSource = true;
      let executions = 0;
      const guestError = Object.assign(new Error('guest failure'),{code:'ERR_METHOD_NOT_IMPLEMENTED'});
      globalThis.__nodeLearningThrow = () => { executions++; throw guestError; };
      let caught;
      try { vm.functionConstructors.Function('return globalThis.__nodeLearningThrow()')(); }
      catch(error) { caught = error; }
      finally { delete globalThis.__nodeLearningThrow; }
      assert(caught === guestError && executions === 1, 'Guest execution was replayed');
      checks.guestExecutesOnce = true;
      await verifyFlushAndRetention(this.storage);
      checks.flushCoverageAndRetention = true;
      await verifyLearningPrimordials(this.storage);
      checks.coldNormalizationAndHashUseCapturedBuiltins = true;
      await verifyPersistentLearningHooks(this.storage);
      checks.persistentGuestHooksSkipLearningAndRecover = true;
      await verifyPersistentByteLength(this.storage);
      checks.persistentByteLengthUsesCapturedIntrinsic = true;
      await verifyHashHelpers(this.storage);
      checks.persistentHashHelpersPreserveDigest = true;
      await verifyPersistentPromiseHooks(this.storage);
      checks.persistentPromiseHooksPreserveRetainedCode = true;
      await verifyLearningQueueSetters();
      checks.learningQueuesIgnoreInheritedSetters = true;
      await verifyPreparationHooks(this.storage);
      checks.preparationHooksPreserveStoredEntries = true;
      await vm.flushLearning();
      const map = await this.generated.prepare(1048576);
      const delta = {interpreter:this.counts.interpreter-before.interpreter,native:this.counts.native-before.native};
      if (phase === 'cold') {
        assert(delta.interpreter === 84 && delta.native === 0, 'Cold boot bypassed the interpreter');
        assert(Object.keys(map.modules).length === 21, 'Eligible successful compilations were not persisted');
      } else {
        assert(delta.interpreter === 48 && delta.native === 36, 'Next boot native/interpreted counts differ');
      }
      checks[phase === 'cold' ? 'interpretedAndPersisted' : 'nextBootNativeAndLiveCjs'] = true;
      return Response.json({ok:true,phase,checks,counts:delta,modules:Object.keys(map.modules).length});
    } catch(error) {
      return Response.json({ok:false,phase,checks,counts:this.counts,error:String(error),stack:error.stack},{status:500});
    }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: `node-vm-learning-${phase}-v1`,
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeVmLearningFacet",
        modules: {
          "main.js": { path: "main.js", type: "js" },
          "learning-runtime.js": { path: "learning-runtime.js", type: "js" },
          ...Object.fromEntries(
            [...Object.values(NODE_VM_PREPARED_MODULES), ...names].map((path) => [
              path,
              { path, type: "cjs" },
            ]),
          ),
        },
        paths: ["/status", "/prepare", "/again"],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error(
      "Pass a fixture output directory, optional prepared directory and optional learned-map JSON",
    );
  const preparedDirectory = process.argv[3];
  const preparedPath = process.argv[4];
  const prepared = preparedPath
    ? (JSON.parse(await NodeFSP.readFile(preparedPath, "utf8")) as NodeGeneratedCodeModuleMap)
    : undefined;
  await prepareNodeVmLearningProof(NodePath.resolve(destination), {
    ...(preparedDirectory ? { preparedDirectory } : {}),
    ...(prepared ? { prepared } : {}),
  });
}
