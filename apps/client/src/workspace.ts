export type SessionIntent = {
  hostId: string;
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
      sessions
        .slice(0, 20)
        .map(({ hostId, attached }) => ({
          hostId,
          ...(attached
            ? { attached: { kind: attached.kind, name: attached.name } }
            : {}),
        })),
    ),
  );
}
