import {useEffect, useState} from 'react';
import {cleanTitle, reportKey, type AgentSession} from './agentReports';

/** The names a user gave sessions on this device, per host, by `reportKey`. A user name wins over any reported title. */
export type AgentNames = Readonly<Record<string, string>>;

const storageKey = 'lazysh.agentNames.v1';
const changed = 'lazysh-agent-names';
const maxHosts = 32;
const maxNames = 100;

function readAll(): Record<string, AgentNames> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(-maxHosts).map(([host, names]) => [host, Object.fromEntries(
      Object.entries(names && typeof names === 'object' ? names : {}).flatMap(([key, name]) => {
        const clean = cleanTitle(name);
        return clean === undefined ? [] : [[key, clean]];
      }).slice(-maxNames))]));
  } catch { return {}; }
}

export function readNames(host: string): AgentNames {
  return readAll()[host] ?? {};
}

/** Several hosts' names from one read of the storage. */
export function readHostNames(hosts: readonly string[]): Record<string, AgentNames> {
  const all = readAll();
  return Object.fromEntries(hosts.map(host => [host, all[host] ?? {}]));
}

/** Names one session on this device; an empty name removes it so the reported title shows again. The oldest names go past the cap. */
export function saveName(host: string, row: Pick<AgentSession, 'agent' | 'sessionId'>, name: string) {
  const all = readAll();
  const key = reportKey(row);
  const names = {...all[host]};
  delete names[key];
  const clean = cleanTitle(name);
  if (clean !== undefined) names[key] = clean;
  if (Object.keys(names).length > 0) all[host] = Object.fromEntries(Object.entries(names).slice(-maxNames)); else delete all[host];
  try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-maxHosts)))); } catch { /* The name lasts for this session. */ }
  window.dispatchEvent(new CustomEvent(changed, {detail: {host, names: all[host] ?? {}}}));
}

/** This host's names, current while any view of the host renames a session. */
export function useNames(host: string): AgentNames {
  const [state, setState] = useState(() => ({host, names: readNames(host)}));
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{host: string; names: AgentNames}>).detail;
      if (detail.host === host) setState({host, names: detail.names});
    };
    window.addEventListener(changed, update);
    return () => window.removeEventListener(changed, update);
  }, [host]);
  return state.host === host ? state.names : readNames(host);
}

/** The rows with the user's names in place of their reported titles. Unchanged rows keep their identity. */
export function withNames(rows: readonly AgentSession[], names: AgentNames): AgentSession[] {
  return rows.map(row => {
    const name = names[reportKey(row)];
    return name === undefined || name === row.title ? row : {...row, title: name};
  });
}
