// Bump this when the wrapper changes: WorkerLoader IDs must always name immutable code.
export const MANAGED_INVOCATION_VERSION = "managed-invocation-v1";

export function managedInvocationModule(mainModule: string) {
  return `import {WorkerEntrypoint,RpcTarget} from "cloudflare:workers";
class Invocation extends RpcTarget {
  #controller = new AbortController();
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
    this.#controller.signal.throwIfAborted();
    this.#run=(async()=>{
      const {default:User}=await import(${JSON.stringify(`./${mainModule}`)});
      this.#controller.signal.throwIfAborted();
      const handler=typeof User==="function" && User.prototype instanceof WorkerEntrypoint
        ? new User(this.#ctx,this.#env) : User;
      const request=new Request("https://generated.invalid/invoke",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify(this.#input),signal:this.#controller.signal,
      });
      const response=await handler.fetch(request,this.#env,this.#ctx);
      this.#reader=response.body?.getReader();
      return {status:response.status,statusText:response.statusText,headers:[...response.headers],hasBody:!!response.body};
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
        const next=await reader.read();
        if(this.#cancellation) {await this.#cancellation;return {done:true};}
        if(next.done) {reader.releaseLock();this.#reader=undefined;return {done:true};}
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
      this.#controller.abort(new DOMException("Generated invocation cancelled","AbortError"));
      if(this.#run) {try {await this.#run;} catch {}}
      const reader=this.#reader;
      if(reader) {await reader.cancel();reader.releaseLock();this.#reader=undefined;}
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
