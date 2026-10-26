import type {AutoOptions, EtOptions, MoshOptions, MultiplexerKind} from "./bridge";
export type SessionAttachment = {kind: MultiplexerKind; name: string; restoreName?: string | null; tmuxServer?: string};
export type SessionIntent = {
  hostId?: string;
  local?: true;
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
export function readWorkspace(): SessionIntent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value) || value.length > 20) return [];
    return value.filter(
      (item): item is SessionIntent =>
        (item?.local === true && Object.keys(item).length === 1) || (
        !!item &&
        typeof item === "object" &&
        item.local === undefined &&
        typeof item.hostId === "string" &&
        item.hostId.length > 0 &&
        item.hostId.length <= 100 &&
        !(item.mosh && item.attached) &&
        !(item.et && (item.mosh || item.attached)) &&
        !(item.auto && (item.mosh || item.et || item.attached)) &&
        (!item.auto || (validMosh(item.auto.mosh) && validEt(item.auto.et))) &&
        (!item.et || validEt(item.et)) &&
        (!item.mosh || validMosh(item.mosh)) &&
        (!item.attached ||
          (["tmux", "herdr", "zellij"].includes(item.attached.kind) &&
            typeof item.attached.name === "string" &&
            item.attached.name.length > 0 &&
            item.attached.name.length <= 200 &&
            (item.attached.kind !== 'tmux' || validTmuxName(item.attached.name)) &&
            (item.attached.tmuxServer === undefined || (item.attached.kind === 'tmux' && validTmuxServer(item.attached.tmuxServer)))))),
    );
  } catch {
    return [];
  }
}
export function saveWorkspace(sessions: (SessionIntent & {attached?: SessionAttachment})[]) {
  // Persist only connection intentions; terminal content and credentials never enter browser storage.
  localStorage.setItem(
    key,
    JSON.stringify(
      sessions.filter(({attached}) => !attached || (attached.restoreName !== null &&
        (attached.kind !== 'tmux' || validTmuxName(attached.restoreName ?? attached.name)) &&
        (attached.tmuxServer === undefined || (attached.kind === 'tmux' && validTmuxServer(attached.tmuxServer)))))
        .slice(0, 20).map(({ hostId, attached, mosh, et, auto, local }) => local ? {local:true} : ({
        hostId,
        ...(auto ? {auto:{mosh:publicMosh(auto.mosh),et:publicEt(auto.et)}} : {}),
        ...(!auto && et ? { et: publicEt(et) } : {}),
        ...(!auto && mosh
          ? {
              mosh: {
                serverPath: mosh.serverPath,
                portMin: mosh.portMin,
                portMax: mosh.portMax,
              },
            }
          : {}),
        ...(!auto && attached
          ? { attached: { kind: attached.kind, name: attached.restoreName ?? attached.name, ...(attached.tmuxServer === undefined ? {} : {tmuxServer:attached.tmuxServer}) } }
          : {}),
      })),
    ),
  );
}
