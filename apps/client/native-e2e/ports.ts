import {createServer,type Server,type Socket} from 'node:net';

export type OwnedPorts={target:number;driver:number;native:number};
export function assertDistinctPorts(ports:OwnedPorts) {
  const values=Object.values(ports);
  if(values.some(port=>!Number.isInteger(port)||port<1||port>65535)||new Set(values).size!==3)throw new Error('Owned GUI endpoint ports must be valid and distinct');
}
function portRole(port:number|undefined,ports:OwnedPorts) {
  if(port)for(const role of ['target','driver','native'] as const)if(ports[role]===port)return role;
  return 'other' as const;
}
export function acceptedEndpointRoles(socket:Socket,server:Server,ports:OwnedPorts) {
  const address=server.address();
  return {
    listener:portRole(address&&typeof address==='object'?address.port:undefined,ports),
    local:portRole(socket.localPort,ports),peer:portRole(socket.remotePort,ports),
    loopback:socket.localAddress==='127.0.0.1'&&socket.remoteAddress==='127.0.0.1',
    selfTuple:socket.localPort!==undefined&&socket.localPort===socket.remotePort&&socket.localAddress===socket.remoteAddress,
  };
}

export async function driverPorts() {
  const servers=[createServer(),createServer()];
  const opened=await Promise.allSettled(servers.map(server=>new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);})));
  const ports=servers.map(server=>(server.address() as {port:number}|null)?.port??0);
  const closed=await Promise.allSettled(servers.map(server=>server.listening?new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes())):Promise.resolve()));
  const failures=[...opened,...closed].filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Owned GUI port allocation failed');
  return ports as [number,number];
}
