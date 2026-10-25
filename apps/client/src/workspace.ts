export type SessionIntent = {
  hostId: string;
  et?: { serverPath: string; port: number };
  mosh?: { serverPath: string; portMin: number; portMax: number };
  attached?: { kind: "tmux" | "herdr" | "zellij"; name: string };
};
const key = "lazysh.workspace.v1";
export function readWorkspace(): SessionIntent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value) || value.length > 20) return [];
    return value.filter(
      (item): item is SessionIntent =>
        !!item &&
        typeof item === "object" &&
        typeof item.hostId === "string" &&
        item.hostId.length > 0 &&
        item.hostId.length <= 100 &&
        !(item.mosh && item.attached) &&
        !(item.et && (item.mosh || item.attached)) &&
        (!item.et ||
          (typeof item.et.serverPath === "string" &&
            item.et.serverPath.length > 0 &&
            item.et.serverPath.length <= 4096 &&
            !/[\x00-\x1f\x7f]/.test(item.et.serverPath) &&
            Number.isInteger(item.et.port) &&
            item.et.port >= 1 &&
            item.et.port <= 65535)) &&
        (!item.mosh ||
          (typeof item.mosh.serverPath === "string" &&
            item.mosh.serverPath.length > 0 &&
            item.mosh.serverPath.length <= 4096 &&
            !/[\x00-\x1f\x7f]/.test(item.mosh.serverPath) &&
            Number.isInteger(item.mosh.portMin) &&
            Number.isInteger(item.mosh.portMax) &&
            item.mosh.portMin >= 1 &&
            item.mosh.portMax <= 65535 &&
            item.mosh.portMax >= item.mosh.portMin &&
            item.mosh.portMax - item.mosh.portMin <= 1000)) &&
        (!item.attached ||
          (["tmux", "herdr", "zellij"].includes(item.attached.kind) &&
            typeof item.attached.name === "string" &&
            item.attached.name.length > 0 &&
            item.attached.name.length <= 200)),
    );
  } catch {
    return [];
  }
}
export function saveWorkspace(sessions: SessionIntent[]) {
  // Persist only connection intentions; terminal content and credentials never enter browser storage.
  localStorage.setItem(
    key,
    JSON.stringify(
      sessions.slice(0, 20).map(({ hostId, attached, mosh, et }) => ({
        hostId,
        ...(et ? { et: { serverPath: et.serverPath, port: et.port } } : {}),
        ...(mosh
          ? {
              mosh: {
                serverPath: mosh.serverPath,
                portMin: mosh.portMin,
                portMax: mosh.portMax,
              },
            }
          : {}),
        ...(attached
          ? { attached: { kind: attached.kind, name: attached.name } }
          : {}),
      })),
    ),
  );
}
