import type {AutoOptions, EtOptions, MoshOptions, MultiplexerKind} from "./bridge";
import {isTmuxFamily} from "./multiplexerFamily";
export type SessionAttachment = {kind: MultiplexerKind; name: string; restoreName?: string | null; tmuxServer?: string};
export type SessionIntent = {
  hostId?: string;
  local?: true;
  /** The local target of a local session (`pwsh`, `wsl:Ubuntu`, ...); the default shell saves none. */
  target?: string;
  auto?: AutoOptions;
  et?: { serverPath: string; port: number };
  mosh?: { serverPath: string; portMin: number; portMax: number };
  attached?: Pick<SessionAttachment, 'kind' | 'name' | 'tmuxServer'>;
};
function validMosh(value: MoshOptions) {
  return !!value && typeof value.serverPath === 'string' && value.serverPath.length > 0 && value.serverPath.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value.serverPath)
    && Number.isInteger(value.portMin) && Number.isInteger(value.portMax) && value.portMin >= 1 && value.portMax <= 65535 && value.portMax >= value.portMin && value.portMax - value.portMin <= 1000;
}
function validEt(value: EtOptions) {
  return !!value && typeof value.serverPath === 'string' && value.serverPath.length > 0 && value.serverPath.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value.serverPath)
    && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535;
}
function publicMosh(value:MoshOptions):MoshOptions { return {serverPath:value.serverPath,portMin:value.portMin,portMax:value.portMax}; }
function publicEt(value:EtOptions):EtOptions { return {serverPath:value.serverPath,port:value.port}; }
const key = "lazysh.workspace.v1";
export function validTmuxServer(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && new TextEncoder().encode(name).length <= 64
    && !['.', '..'].includes(name) && !/[\/\x00-\x1f\x7f-\x9f]/.test(name);
}
function validTmuxName(name: string) {
  return name.length > 0 && new TextEncoder().encode(name).length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(name);
}
/** A target id native detection can produce; `default` is never saved. */
function validLocalTarget(target: unknown) {
  return typeof target === 'string' && /^(pwsh|powershell|gitbash|wsl:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(target);
}
function validAttachment(attached: SessionIntent['attached'] & object) {
  return ["tmux", "rmux", "herdr", "zellij"].includes(attached.kind) &&
    typeof attached.name === "string" &&
    attached.name.length > 0 &&
    attached.name.length <= 200 &&
    (!isTmuxFamily(attached.kind) || validTmuxName(attached.name)) &&
    (attached.tmuxServer === undefined || (isTmuxFamily(attached.kind) && validTmuxServer(attached.tmuxServer)));
}
export function readWorkspace(): SessionIntent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value) || value.length > 20) return [];
    return value.filter(
      (item): item is SessionIntent =>
        (item?.local === true && Object.keys(item).every(name => name === 'local' || (name === 'target' && validLocalTarget(item.target)) || name === 'attached')
          // A multiplexer attaches on this device's own shell, never in another target.
          && (!item.attached || (item.target === undefined && ['tmux', 'herdr', 'zellij'].includes(item.attached.kind) && validAttachment(item.attached)))) || (
        !!item &&
        typeof item === "object" &&
        item.local === undefined &&
        typeof item.hostId === "string" &&
        item.hostId.length > 0 &&
        item.hostId.length <= 100 &&
        !(item.et && (item.mosh || item.attached)) &&
        !(item.auto && (item.mosh || item.et)) &&
        (!item.auto || (validMosh(item.auto.mosh) && validEt(item.auto.et))) &&
        (!item.et || validEt(item.et)) &&
        (!item.mosh || validMosh(item.mosh)) &&
        (!item.attached || validAttachment(item.attached))),
    );
  } catch {
    return [];
  }
}
type LiveIntent = SessionIntent & {attached?: SessionAttachment};
function restorableAttachment({attached}: LiveIntent) {
  return !attached || (attached.restoreName !== null &&
    (!isTmuxFamily(attached.kind) || validTmuxName(attached.restoreName ?? attached.name)) &&
    (attached.tmuxServer === undefined || (isTmuxFamily(attached.kind) && validTmuxServer(attached.tmuxServer))));
}
/** The saved connection intention of one live session; terminal content and credentials stay out. */
export function sessionIntent({hostId, attached, mosh, et, auto, local, target}: LiveIntent): SessionIntent {
  const attachment = attached && restorableAttachment({attached})
    ? { attached: { kind: attached.kind, name: attached.restoreName ?? attached.name, ...(attached.tmuxServer === undefined ? {} : {tmuxServer:attached.tmuxServer}) } }
    : {};
  return local ? {local:true, ...(validLocalTarget(target) ? {target} : attachment)} : ({
    hostId,
    ...(auto ? {auto:{mosh:publicMosh(auto.mosh),et:publicEt(auto.et)}} : {}),
    ...(!auto && et ? { et: publicEt(et) } : {}),
    ...(!auto && mosh ? { mosh: publicMosh(mosh) } : {}),
    ...attachment,
  });
}
export function saveWorkspace(sessions: LiveIntent[]) {
  // Persist only connection intentions; terminal content and credentials never enter browser storage.
  localStorage.setItem(key, JSON.stringify(sessions.filter(restorableAttachment).slice(0, 20).map(sessionIntent)));
}
