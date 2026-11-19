import { useRef, useState } from "react";
import { useProtectedInvoke } from "./access";
import { t, useUi } from "./i18n/core";
import {
  captureUiError,
  LocalUiError,
  uiErrorText,
  type UiErrorCause,
} from "./i18n/localError";

export type UiNode = {
  depth: number;
  class: string;
  resourceId: string;
  text: string;
  contentDescription: string;
  occurrence: number;
  enabled: boolean;
  clickable: boolean;
  scrollable: boolean;
  checked: boolean;
};
const strings = ["class", "resourceId", "text", "contentDescription"] as const;
const flags = ["enabled", "clickable", "scrollable", "checked"] as const;
/** The host bounds the tree (300 nodes, 256 characters per text); anything else is not its answer. */
export function parseTree(value: unknown, id: string) {
  const tree = value as { schemaVersion?: number; platform?: string; id?: string; truncated?: boolean; nodes?: UiNode[] };
  if (
    tree?.schemaVersion !== 1 ||
    tree.platform !== "android" ||
    tree.id !== id ||
    typeof tree.truncated !== "boolean" ||
    !Array.isArray(tree.nodes) ||
    tree.nodes.length > 300 ||
    tree.nodes.some(
      (node) =>
        !Number.isInteger(node?.depth) ||
        node.depth < 0 ||
        node.depth > 64 ||
        !Number.isInteger(node.occurrence) ||
        node.occurrence < 0 ||
        strings.some((key) => typeof node[key] !== "string" || node[key].length > 1024) ||
        flags.some((key) => typeof node[key] !== "boolean"),
    )
  )
    throw new LocalUiError("devicesInvalidTree");
  return { truncated: tree.truncated, nodes: tree.nodes };
}
const shortName = (value: string) => value.split(/[./:]/).pop() || value;
const label = (node: UiNode) =>
  node.text || node.contentDescription || shortName(node.resourceId) || shortName(node.class);

/** Inspect the foreground screen's accessibility nodes and tap or long-press one of them. */
export default function DeviceAccessibility({
  sessionId,
  id,
  inputEnabled,
}: {
  sessionId: string;
  id: string;
  inputEnabled: boolean;
}) {
  useUi();
  const invoke = useProtectedInvoke();
  const [tree, setTree] = useState<ReturnType<typeof parseTree>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiErrorCause>("");
  const [sent, setSent] = useState("");
  const running = useRef(false);
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setSent("");
    try {
      await work();
    } catch (e) {
      setError(captureUiError(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="tool-bar">
        <button
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setTree(parseTree(await invoke("android_ui_tree", { sessionId, id }), id)),
            )
          }
        >
          {t("devicesInspect")}
        </button>
        <span>{t("devicesInspectHint")}</span>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {uiErrorText(error)}
        </p>
      )}
      {sent && <p role="status">{sent}</p>}
      {tree && tree.nodes.length === 0 && <p>{t("devicesNodesNone")}</p>}
      {tree?.truncated && <p role="status">{t("devicesNodesTruncated", { count: tree.nodes.length })}</p>}
      <ul aria-label={t("devicesNodes")}>
        {tree?.nodes.map((node, index) => (
          <li key={index} style={{ paddingLeft: Math.min(node.depth, 12) * 8 }}>
            <span>{label(node)}</span> <small>{shortName(node.class)}</small>
            {(["click", "long-click"] as const).map((kind) => (
              <button
                key={kind}
                disabled={busy || !inputEnabled || !node.enabled}
                onClick={() =>
                  void run(async () => {
                    await invoke("android_ui_action", {
                      sessionId,
                      id,
                      node: {
                        resourceId: node.resourceId,
                        text: node.text,
                        contentDescription: node.contentDescription,
                        occurrence: node.occurrence,
                      },
                      kind,
                    });
                    setSent(t(kind === "click" ? "devicesNodeTapped" : "devicesNodePressed", { name: label(node) }));
                  })
                }
              >
                {t(kind === "click" ? "devicesNodeTap" : "devicesNodeLongPress")}
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
