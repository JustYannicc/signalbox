// Bump this when the wrapper changes: WorkerLoader IDs must always name immutable code.
export const MANAGED_INVOCATION_VERSION = "managed-invocation-v2";

export function managedInvocationModule(mainModule: string) {
  return `import {WorkerEntrypoint,RpcTarget} from "cloudflare:workers";
// User code shares this realm. Only native operations can establish body completion.
const apply=Reflect.apply;
function nativeGetter(target,key){
  while(target){
    const descriptor=Object.getOwnPropertyDescriptor(target,key);
    if(descriptor?.get)return descriptor.get;
    target=Object.getPrototypeOf(target);
  }
  throw new Error("Missing native getter: "+key);
}
const bodyOf=nativeGetter(new Response(),"body");
const getReader=ReadableStream.prototype.getReader;
const read=ReadableStreamDefaultReader.prototype.read;
const cancel=ReadableStreamDefaultReader.prototype.cancel;
const releaseLock=ReadableStreamDefaultReader.prototype.releaseLock;
const NativeAbortController=AbortController,NativeRequest=Request;
const signalOf=nativeGetter(new NativeAbortController(),"signal");
const abort=AbortController.prototype.abort;
const throwIfAborted=AbortSignal.prototype.throwIfAborted;
class Invocation extends RpcTarget {
  #controller = new NativeAbortController();
  #signal = apply(signalOf,this.#controller,[]);
  #run;
  #reader;
  #cancellation;
  #reading = false;
  #remaining;
  #input;
  #ctx;
  #env;
  constructor(input,ctx,env) {super();this.#input=input;this.#ctx=ctx;this.#env=env;}
  run() {
    if(this.#run) throw new Error("Generated invocation already started");
    apply(throwIfAborted,this.#signal,[]);
    this.#run=(async()=>{
      const {default:User}=await import(${JSON.stringify(`./${mainModule}`)});
      apply(throwIfAborted,this.#signal,[]);
      const handler=typeof User==="function" && User.prototype instanceof WorkerEntrypoint
        ? new User(this.#ctx,this.#env) : User;
      const request=new NativeRequest("https://generated.invalid/invoke",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify(this.#input),signal:this.#signal,
      });
      const response=await handler.fetch(request,this.#env,this.#ctx);
      const body=apply(bodyOf,response,[]);
      this.#reader=body===null ? undefined : apply(getReader,body,[]);
      return {status:response.status,statusText:response.statusText,headers:[...response.headers],hasBody:body!==null};
    })();
    return this.#run;
  }
  async read() {
    if(this.#reading) throw new Error("Concurrent generated body reads");
    this.#reading=true;
    try {
      if(this.#cancellation) {await this.#cancellation;return {done:true};}
      const reader=this.#reader;
      if(!reader) return {done:true};
      let bytes=this.#remaining;
      if(!bytes) {
        const next=await apply(read,reader,[]);
        if(this.#cancellation) {await this.#cancellation;return {done:true};}
        if(next.done) {apply(releaseLock,reader,[]);this.#reader=undefined;return {done:true};}
        bytes=next.value;
        if(!(bytes instanceof Uint8Array)) throw new TypeError("Generated body must contain bytes");
      }
      const chunk=bytes.slice(0,65536);
      this.#remaining=bytes.length>65536 ? bytes.subarray(65536) : undefined;
      return {done:false,value:chunk};
    } finally {this.#reading=false;}
  }
  cancel() {
    return this.#cancellation ??= (async()=>{
      apply(abort,this.#controller,[]);
      if(this.#run) {try {await this.#run;} catch {}}
      const reader=this.#reader;
      if(reader) {await apply(cancel,reader,[]);apply(releaseLock,reader,[]);this.#reader=undefined;}
      this.#remaining=undefined;
    })();
  }
}
export class ManagedInvocation extends WorkerEntrypoint {
  open(input) {return new Invocation(input,this.ctx,this.env);}
}
`;
}

export function managedInvocationModules(mainModule: string, modules: Record<string, string>) {
  let wrapper = "__signalbox_generated_invocation.js";
  const paths = new Set(
    Object.keys(modules).map((name) => new URL(name, "https://generated.invalid/").pathname),
  );
  while (paths.has(`/${wrapper}`)) wrapper = `_${wrapper}`;
  return {
    mainModule: wrapper,
    modules: { ...modules, [wrapper]: managedInvocationModule(mainModule) },
  };
}
