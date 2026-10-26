/** Holds only application acknowledgements; IndexedDB and the bundled font parser stay real. */
export function observeFontOperations() {
  const counts={open:0,transaction:0,read:0,add:0,remove:0,load:0};
  let hold:'load'|'delete'|undefined,finish:(()=>void)|undefined;
  const pendingDeletes=new WeakSet<IDBTransaction>();
  const open=indexedDB.open;
  indexedDB.open=function(...args:Parameters<IDBFactory['open']>){counts.open++;return open.apply(this,args);};
  const transaction=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase['transaction']>){counts.transaction++;return transaction.apply(this,args);};
  for(const [method,counter] of [['getAll','read'],['add','add'],['delete','remove']] as const){
    const original=IDBObjectStore.prototype[method];
    Object.defineProperty(IDBObjectStore.prototype,method,{configurable:true,value:function(this:IDBObjectStore,...args:unknown[]){
      counts[counter]++;if(method==='delete' && hold==='delete')pendingDeletes.add(this.transaction);
      return Reflect.apply(original,this,args);
    }});
  }
  const completion=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete')!;
  Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...completion,set(this:IDBTransaction,callback:((event:Event)=>void)|null){
    completion.set!.call(this,callback?((event:Event)=>{
      if(pendingDeletes.has(this)){finish=()=>callback.call(this,event);}else callback.call(this,event);
    }):null);
  }});
  const load=FontFace.prototype.load;
  FontFace.prototype.load=function(){
    counts.load++;const parsed=load.call(this);
    return hold==='load'?parsed.then(face=>new Promise<FontFace>(resolve=>{finish=()=>resolve(face);})):parsed;
  };
  return {counts,hold(operation:typeof hold){hold=operation;},pending:()=>!!finish,finish(){const done=finish;finish=undefined;hold=undefined;done?.();}};
}
