import {open,readdir,readlink} from 'node:fs/promises';
import type {Socket} from 'node:net';
import {sameIdentity,type OwnedPid} from '../../../tests/support/ownedProcess';
import {listenerInode} from './policy';

function ignoreRetiredProcess(error:unknown):undefined {
  if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;
}

export async function socketInventory() {
  const file=await open('/proc/net/tcp','r'),buffer=Buffer.alloc(256*1024+1);let length=0;
  try {
    while(length<buffer.length) {
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
      if(!bytesRead)return buffer.subarray(0,length).toString('utf8');
      length+=bytesRead;
    }
    throw new Error('Owned GUI socket inventory bound exceeded');
  } finally {await file.close();}
}

async function ownerOfSocket(inode:string|undefined,members:OwnedPid[]) {
  if(members.length>64)throw new Error('Owned GUI attribution candidate bound exceeded');
  if(!inode||!/^\d+$/.test(inode)||inode==='0')return;
  for(const item of members)try {
    if(!await sameIdentity(item))continue;
    for(const fd of (await readdir(`/proc/${item.pid}/fd`)).slice(0,256)) {
      if(await readlink(`/proc/${item.pid}/fd/${fd}`).catch(ignoreRetiredProcess)!==`socket:[${inode}]`)continue;
      const executable=await readlink(`/proc/${item.pid}/exe`);
      if(await sameIdentity(item))return {identity:item,executable};
    }
  } catch(error) {ignoreRetiredProcess(error);}
}

export async function acceptedConnectionOwner(socket:Socket,ownedMembers:()=>Promise<OwnedPid[]>) {
  const clientPort=socket.remotePort,targetPort=socket.localPort;
  if(clientPort===undefined||targetPort===undefined)return;
  const address=(port:number)=>`0100007F:${port.toString(16).padStart(4,'0').toUpperCase()}`;
  const [table,members]=await Promise.all([socketInventory(),ownedMembers()]);
  const rows=table.split('\n').slice(1).map(line=>line.trim().split(/\s+/)).filter(fields=>fields[1]===address(clientPort)&&fields[2]===address(targetPort)&&fields[3]==='01');
  if(rows.length>1)throw new Error('Ambiguous owned GUI peer socket');
  return ownerOfSocket(rows[0]?.[9],members);
}

export async function listeningConnectionOwner(port:number,ownedMembers:()=>Promise<OwnedPid[]>) {
  const [table,members]=await Promise.all([socketInventory(),ownedMembers()]);
  return ownerOfSocket(listenerInode(table,port),members);
}
