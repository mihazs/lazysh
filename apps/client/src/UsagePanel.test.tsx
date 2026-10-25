// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import UsagePanel, { parseUsage, sampleFreshness, windowFreshness } from "./UsagePanel";
vi.mock("@tauri-apps/api/core", async original => ({ ...(await original<typeof import("@tauri-apps/api/core")>()), invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const sample = { id: "record1", recordedAt: "2026-10-24T18:00:00Z", freshness: "stale" as const, inputTokens: 120, outputTokens: 12, cacheReadTokens: null, cacheWriteTokens: null };
const snapshot = { schemaVersion: 1, agent: "claude", scope: "transcript_window", observedAt: "2026-10-24T20:00:00Z", nextOffset: 500, hasMore: false, samplesAvailable: 1, samples: [sample], context: { usedTokens: null, limitTokens: null, remainingTokens: null }, quota: { remaining: null, resetsAt: null } };

it("rejects fake limits, invalid counters and unbounded or contradictory snapshots", () => {
  expect(parseUsage(snapshot)).toEqual(snapshot);
  for (const value of [null, { ...snapshot, scope: "account_total" }, { ...snapshot, nextOffset: -1 }, { ...snapshot, samples: [{ ...sample, inputTokens: -1 }] }, { ...snapshot, samples: [{ ...sample, outputTokens: Number.MAX_SAFE_INTEGER + 1 }] }, { ...snapshot, samples: [{ ...sample, recordedAt: null, freshness: "fresh" }] }, { ...snapshot, context: { ...snapshot.context, remainingTokens: 999 } }, { ...snapshot, samples: [sample, sample], samplesAvailable: 2 }]) expect(() => parseUsage(value)).toThrow();
});

it("ages displayed reports without network collection and preserves unknown timestamps", () => {
  const fresh = { ...sample, recordedAt: "2026-10-24T19:59:00Z", freshness: "fresh" as const };
  expect(sampleFreshness(fresh, snapshot.observedAt, 0)).toBe("fresh");
  expect(sampleFreshness(fresh, snapshot.observedAt, 15 * 60_000)).toBe("stale");
  expect(sampleFreshness({ ...fresh, recordedAt: null, freshness: "unknown" }, snapshot.observedAt, 0)).toBe("unknown");
});

it("collects only after an explicit request, labels stale samples, and keeps context unknown", async () => {
  vi.mocked(invoke).mockResolvedValue(snapshot);
  render(<UsagePanel sessionId="ssh1" />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Usage transcript path"), { target: { value: "/host/session.jsonl" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect usage" }));
  await screen.findByText("Stale report");
  expect(invoke).toHaveBeenCalledWith("agent_usage", { sessionId: "ssh1", agent: "claude", path: "/host/session.jsonl", offset: 0 });
  expect(screen.getByText("Context remaining").nextElementSibling?.textContent).toBe("Unknown");
  expect(screen.queryByText("240")).toBeNull();
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(3);
});

it("pages using the opaque cursor and rejects mismatched source identity", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...snapshot, hasMore: true }).mockResolvedValueOnce({ ...snapshot, agent: "copilot", nextOffset: 900 });
  render(<UsagePanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Usage transcript path"), { target: { value: "/host/session.jsonl" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect usage" }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect next records" }));
  await screen.findByRole("alert");
  expect(invoke).toHaveBeenLastCalledWith("agent_usage", { sessionId: "ssh1", agent: "claude", path: "/host/session.jsonl", offset: 500 });
});

it("renders an explicit zero counter without replacing missing metrics with zero", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...snapshot, samples: [{ ...sample, outputTokens: 0 }] });
  render(<UsagePanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Usage transcript path"), { target: { value: "/host/session.jsonl" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect usage" }));
  await screen.findByText("Stale report");
  expect(screen.getByText("Output tokens").nextElementSibling?.textContent).toBe("0");
  expect(screen.getByText("Cache read tokens").nextElementSibling?.textContent).toBe("Unknown");
});

it("discards an old host response after the SSH session changes", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise(result => { resolve = result; }));
  const { rerender } = render(<UsagePanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Usage transcript path"), { target: { value: "/host/session.jsonl" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect usage" }));
  rerender(<UsagePanel sessionId="ssh2" />); resolve(snapshot);
  await waitFor(() => expect(screen.queryByText("Stale report")).toBeNull());
  expect(screen.getByLabelText("Usage transcript path")).toHaveProperty("value", "");
});

const recordedContext = { source: "codex_token_count" as const, usedTokens: 132, limitTokens: 1000, recordedAt: "2026-10-24T19:59:00Z", freshness: "fresh" as const };
const providerWindow = { provider: "codex" as const, accountId: null, limitId: "codex", kind: "primary" as const, usedPercent: 12.5, windowMinutes: 300, resetsAt: "2026-10-24T20:01:00Z", recordedAt: "2026-10-24T19:59:00Z", freshness: "fresh" as const };

it("validates recorded Codex metadata while retaining unknown live limits", () => {
  const value = { ...snapshot, agent: "codex", recordedContext, providerWindows: [providerWindow] };
  expect(parseUsage(value)).toEqual(value);
  for (const invalid of [
    { ...value, agent: "claude" },
    { ...value, recordedContext: { ...recordedContext, usedTokens: -1 } },
    { ...value, recordedContext: { ...recordedContext, recordedAt: null } },
    { ...value, providerWindows: [{ ...providerWindow, usedPercent: 101 }] },
    { ...value, providerWindows: [{ ...providerWindow, accountId: "guessed-account" }] },
    { ...value, providerWindows: [{ ...providerWindow, windowMinutes: 0 }] },
    { ...value, providerWindows: [providerWindow, providerWindow] },
    { ...value, providerWindows: Array(17).fill(providerWindow) },
  ]) expect(() => parseUsage(invalid)).toThrow();
  expect(windowFreshness(providerWindow, snapshot.observedAt, 0)).toBe("fresh");
  expect(windowFreshness(providerWindow, snapshot.observedAt, 60_000)).toBe("stale");
});

it("shows recorded context and provider windows without claiming a current account allowance", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...snapshot, agent: "codex", recordedContext, providerWindows: [{ ...providerWindow, usedPercent: 0 }] });
  render(<UsagePanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Usage agent"), { target: { value: "codex" } });
  fireEvent.change(screen.getByLabelText("Usage transcript path"), { target: { value: "/host/rollout.jsonl" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect usage" }));
  await screen.findByRole("heading", { name: "Last recorded response context" });
  expect(screen.getByText("Recorded context tokens").nextElementSibling?.textContent).toBe("132");
  expect(screen.getByText("Recorded context window").nextElementSibling?.textContent).toBe("1,000");
  expect(screen.getByText("Context remaining").nextElementSibling?.textContent).toBe("Unknown");
  expect(screen.getByText("0%")).toBeTruthy();
  expect(screen.getByText(/Account identity is unknown/)).toBeTruthy();
  expect(screen.getByText(/Recording time does not prove/)).toBeTruthy();
});
