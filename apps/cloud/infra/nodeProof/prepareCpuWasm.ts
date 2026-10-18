export const cpuPollReactor = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 9, 1, 96, 4, 127, 127, 127, 127, 1, 127, 2, 38, 1, 22, 119, 97,
  115, 105, 95, 115, 110, 97, 112, 115, 104, 111, 116, 95, 112, 114, 101, 118, 105, 101, 119, 49,
  11, 112, 111, 108, 108, 95, 111, 110, 101, 111, 102, 102, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 16,
  2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 3, 114, 117, 110, 0, 1, 10, 14, 1, 12, 0, 32, 0, 32, 1,
  32, 2, 32, 3, 16, 0, 11,
]);

export const cpuReturnReactor = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 16, 2, 6, 109,
  101, 109, 111, 114, 121, 2, 0, 3, 114, 117, 110, 0, 0, 10, 6, 1, 4, 0, 65, 0, 11,
]);

export const cpuWasmCheckMethods = `
  async checkWasmClockFailures(checks) {
    for(const [key,failAt] of [['jspiClockEntryCleanup',1],['jspiClockLeaveCleanup',2]]) {
      let reads=0;
      const expected=new Error('CPU proof clock failure');
      const accounting=new KernelCpuAccounting(()=>{
        if(++reads===failAt)throw expected;
        return readClock();
      });
      const host=new KernelProgramHost({registry:new KernelProgramRegistry(),cpuAccounting:accounting});
      const owner=host.cpuExecution.root;
      const storage=createFacetSqliteStorage(this.ctx.storage,readClock);
      const filesystem=new KernelFileSystem({mounts:[{path:'/',storage}]});
      const {wasi}=createKernelAsyncWasi({filesystem,wakes:this.wakes});
      const instance=new WebAssembly.Instance(returnReactor,wasi.getImportObject());
      try {
        await wasi.initialize(instance);
        let failure;
        try {await owner.run(()=>wasi.run(instance.exports.run));}
        catch(error){failure=error;}
        await wasi.close();
        owner.stop();
        checks[key]=failure===expected;
      } finally {await wasi.close();filesystem.dispose();}
    }
  }
  async startWasm(owner) {
    return owner.run(async()=>{
      const storage=createFacetSqliteStorage(this.ctx.storage,readClock);
      const filesystem=new KernelFileSystem({mounts:[{path:'/',storage}]});
      const {wasi,descriptors}=createKernelAsyncWasi({filesystem,wakes:this.wakes});
      let ready,notify;
      const subscribed=Promise.withResolvers();
      const fd=descriptors.register({ready:()=>ready,
        subscribe:(_direction,wake)=>{notify=wake;subscribed.resolve();return ()=>{notify=undefined;};},
        close(){}});
      const instance=new WebAssembly.Instance(pollReactor,wasi.getImportObject());
      await wasi.initialize(instance);
      const memory=instance.exports.memory;
      const view=new DataView(memory.buffer);
      new Uint8Array(memory.buffer,0,48).fill(0);
      view.setBigUint64(0,123n,true);view.setUint8(8,1);view.setUint32(16,fd,true);
      const pending=wasi.run(instance.exports.run,0,64,1,96);
      await subscribed.promise;
      return {pending,
        wake:()=>{ready={bytes:7n};notify();},
        valid:()=>view.getUint32(96,true)===1 && view.getBigUint64(80,true)===7n,
        close:async()=>{await wasi.close();descriptors.close(fd);filesystem.dispose();}};
    });
  }
  async checkWasm(checks) {
    const scenario=await this.startWasm(this.root);
    try {
      const blocked=this.process.cpuUsage();
      await new Promise(resolve=>setTimeout(resolve,10));
      checks.jspiWaitExcluded=equal(blocked,this.process.cpuUsage());
      checks.jspiWakeRegistered=this.wakes.size===1;
      scenario.wake();
      checks.jspiWasmResumed=await scenario.pending===0 && scenario.valid();
    } finally {await scenario.close();}
  }
  async checkWasmSiblings(checks) {
    const owners=[this.host.cpuExecution.forProcess(21),this.host.cpuExecution.forProcess(22)];
    const scenarios=await Promise.all(owners.map(owner=>this.startWasm(owner)));
    const snapshots=owners.map(owner=>owner.snapshot());
    try {
      await new Promise(resolve=>setTimeout(resolve,10));
      checks.jspiSiblingWaitExcluded=owners.every((owner,index)=>{
        const current=owner.snapshot(),before=snapshots[index];
        return current.userNs===before.userNs && current.systemNs===before.systemNs;
      });
      checks.jspiSiblingWakesRegistered=this.wakes.size===2;
      const finished=Promise.allSettled(scenarios.map(scenario=>scenario.pending));
      scenarios.forEach(scenario=>scenario.wake());
      const results=await finished;
      checks.jspiSiblingsResumed=results.every(result=>result.status==='fulfilled' && result.value===0);
      checks.jspiSiblingData=scenarios.every(scenario=>scenario.valid());
      checks.jspiSiblingFailures=results.filter(result=>result.status==='rejected').map(result=>String(result.reason)).length===0;
    } finally {
      await Promise.all(scenarios.map(scenario=>scenario.close()));
      owners.forEach(owner=>owner.stop());
    }
  }
`;
