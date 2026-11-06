/** Reports archived on this device, per host. A newer event or age-out ends the archive. */
export type ArchivedReport = Readonly<{agent:string;sessionId:string;updatedAt:string}>;
type Report = Readonly<{agent:string;sessionId:string;updatedAt:string}>;

const storageKey='lazysh.agentArchive.v1';
const maxHosts=32;
const maxReports=100;

function valid(value:unknown):value is ArchivedReport {
  if(!value || typeof value!=='object')return false;
  const row=value as Record<string,unknown>;
  return ['agent','sessionId','updatedAt'].every(key=>typeof row[key]==='string' && (row[key] as string).length>0 && (row[key] as string).length<=4096)
    && Number.isFinite(Date.parse(row.updatedAt as string));
}

function readAll():Record<string,ArchivedReport[]> {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if(!value || typeof value!=='object' || Array.isArray(value))return {};
    return Object.fromEntries(Object.entries(value).slice(-maxHosts).filter(([,rows])=>Array.isArray(rows)).map(([host,rows])=>[host,(rows as unknown[]).filter(valid).slice(-maxReports)]));
  } catch { return {}; }
}

export function readArchive(host:string):ArchivedReport[] {
  return readAll()[host] ?? [];
}

/** Persists one host's archive; the board still works for this session without storage. */
export function saveArchive(host:string,rows:readonly ArchivedReport[]) {
  const all=readAll();
  delete all[host];
  if(rows.length>0)all[host]=rows.slice(-maxReports).map(({agent,sessionId,updatedAt})=>({agent,sessionId,updatedAt}));
  try { localStorage.setItem(storageKey,JSON.stringify(Object.fromEntries(Object.entries(all).slice(-maxHosts)))); } catch { /* Archive lasts for this session. */ }
}

const same=(a:Report,b:Report)=>a.agent===b.agent && a.sessionId===b.sessionId;

export function isArchived(archive:readonly ArchivedReport[],row:Report) {
  return archive.some(entry=>same(entry,row) && Date.parse(entry.updatedAt)>=Date.parse(row.updatedAt));
}

export function archiveReport(archive:readonly ArchivedReport[],row:Report):ArchivedReport[] {
  return [...archive.filter(entry=>!same(entry,row)),{agent:row.agent,sessionId:row.sessionId,updatedAt:row.updatedAt}];
}

export function restoreReport(archive:readonly ArchivedReport[],row:Report):ArchivedReport[] {
  return archive.filter(entry=>!same(entry,row));
}

/** Keeps only entries whose report is still present and has no newer event. */
export function reconcileArchive(archive:readonly ArchivedReport[],rows:readonly Report[]):readonly ArchivedReport[] {
  const next=archive.filter(entry=>rows.some(row=>same(entry,row) && Date.parse(entry.updatedAt)>=Date.parse(row.updatedAt)));
  return next.length===archive.length ? archive : next;
}
