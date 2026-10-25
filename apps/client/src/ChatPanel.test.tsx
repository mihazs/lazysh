// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import ChatPanel, { parseTranscript } from "./ChatPanel";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const message = {
  id: "a",
  role: "assistant",
  blocks: [{ type: "text", text: "Hello **world**" }],
};
const page = {
  schemaVersion: 1,
  agent: "claude",
  messages: [message],
  nextOffset: 80,
  hasMore: false,
};

it("rejects invalid transcript boundaries and executable host content remains inert", () => {
  for (const value of [
    null,
    { ...page, nextOffset: -1 },
    { ...page, agent: "unknown" },
    { ...page, messages: [{ ...message, blocks: [{ type: "script" }] }] },
    { ...page, messages: [{ ...message, usage: { inputTokens: -1 } }] },
  ])
    expect(() => parseTranscript(value)).toThrow();
  expect(parseTranscript(page)).toEqual(page);
});

it("opens explicit Grok record files without discovery or conversation claims", async () => {
  const grok = { ...page, agent: "grok-acp", view: "record_stream" };
  expect(parseTranscript(grok)).toEqual(grok);
  expect(() => parseTranscript({ ...grok, view: "active_branch" })).toThrow();
  expect(() => parseTranscript({ ...grok, view: undefined })).toThrow();
  vi.mocked(invoke).mockResolvedValue(grok);
  render(<ChatPanel sessionId="grok-host" />);
  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "grok-acp" },
  });
  expect(
    screen.getByRole("button", { name: "Find transcripts" }),
  ).toHaveProperty("disabled", true);
  expect(screen.queryByLabelText("View")).toBeNull();
  expect(screen.getByText(/rewinds are not filtered/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Transcript path"), {
    target: { value: "/host/updates.jsonl" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  await screen.findByText("world");
  expect(invoke).toHaveBeenCalledWith("agent_transcript", {
    sessionId: "grok-host",
    agent: "grok-acp",
    path: "/host/updates.jsonl",
    offset: 0,
  });
  expect(
    vi.mocked(invoke).mock.calls.some(([name]) => name === "agent_transcripts"),
  ).toBe(false);
});

it("reads selected host transcript, pages by returned cursor, and does not fetch embedded images", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      ...page,
      messages: [
        {
          ...message,
          blocks: [
            {
              type: "text",
              text: "![secret](https://evil.example/tracking) <script>alert(1)</script>",
            },
          ],
        },
      ],
    })
    .mockResolvedValueOnce({
      ...page,
      messages: [{ ...message, id: "b" }],
      nextOffset: 160,
    });
  const { container } = render(<ChatPanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Transcript path"), {
    target: { value: "/host/session.jsonl" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  await screen.findByText("[Image — view in terminal]");
  expect(container.querySelector("img, script, iframe")).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("agent_transcript", {
    sessionId: "ssh1",
    agent: "claude",
    path: "/host/session.jsonl",
    offset: 0,
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh new messages" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("agent_transcript", {
      sessionId: "ssh1",
      agent: "claude",
      path: "/host/session.jsonl",
      offset: 80,
    }),
  );
  expect(await screen.findByText("world")).toBeTruthy();
});

it("rejects a non-advancing pagination cursor", async () => {
  vi.mocked(invoke).mockResolvedValue({
    ...page,
    nextOffset: 0,
    hasMore: true,
  });
  render(<ChatPanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Transcript path"), {
    target: { value: "/host/session.jsonl" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Transcript changed. Open it again to restart.",
  );
});

it("replaces the visible branch on conversation refresh instead of retaining abandoned messages", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      ...page,
      view: "active_branch",
      messages: [
        { ...message, blocks: [{ type: "text", text: "Abandoned branch" }] },
      ],
    })
    .mockResolvedValueOnce({
      ...page,
      view: "active_branch",
      messages: [
        {
          ...message,
          id: "b",
          blocks: [{ type: "text", text: "Current branch" }],
        },
      ],
    });
  render(<ChatPanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Transcript path"), {
    target: { value: "/host/session.jsonl" },
  });
  fireEvent.change(screen.getByLabelText("View"), {
    target: { value: "conversation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  await screen.findByText("Abandoned branch");
  fireEvent.click(screen.getByRole("button", { name: "Refresh new messages" }));
  await screen.findByText("Current branch");
  expect(screen.queryByText("Abandoned branch")).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("agent_transcript", {
    sessionId: "ssh1",
    agent: "claude",
    path: "/host/session.jsonl",
    view: "conversation",
    offset: 0,
  });
});

it("stages the edited text for exactly the existing terminal without issuing a remote command", () => {
  const staged = vi.fn(); window.addEventListener("lazysh-prompt-draft", staged);
  const openTerminal = vi.fn();
  render(<ChatPanel sessionId="ssh-specific" onOpenTerminal={openTerminal} />);
  expect(screen.getByRole("button", { name: "Stage in terminal" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Draft for this terminal"), { target: { value: "Please review this\n世界" } });
  fireEvent.click(screen.getByRole("button", { name: "Stage in terminal" }));
  expect(staged).toHaveBeenCalledOnce();
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: "ssh-specific", text: "Please review this\n世界" });
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveProperty("textContent", "Review this draft in the terminal before pasting it.");
  expect(screen.getByLabelText("Draft for this terminal")).toHaveProperty("value", "Please review this\n世界");
  expect(screen.queryByRole("button", { name: /send|stop|approve/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" })); expect(openTerminal).toHaveBeenCalledOnce();
  window.removeEventListener("lazysh-prompt-draft", staged);
});

it("does not stage IME composition or plain Enter, and clears the draft when the SSH session changes", () => {
  const staged = vi.fn(); window.addEventListener("lazysh-prompt-draft", staged);
  const { rerender } = render(<ChatPanel sessionId="first" />);
  const input = screen.getByLabelText("Draft for this terminal");
  fireEvent.change(input, { target: { value: "draft" } });
  fireEvent.keyDown(input, { key: "Enter" }); expect(staged).not.toHaveBeenCalled();
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true }); expect(staged).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true }); expect(staged).toHaveBeenCalledOnce();
  rerender(<ChatPanel sessionId="second" />);
  expect(screen.getByLabelText("Draft for this terminal")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Stage in terminal" })).toHaveProperty("disabled", true);
  window.removeEventListener("lazysh-prompt-draft", staged);
});

it("retains an editable draft after a transcript request fails", async () => {
  vi.mocked(invoke).mockRejectedValue({ message: "Transcript unavailable" });
  render(<ChatPanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Draft for this terminal"), { target: { value: "Keep this draft" } });
  fireEvent.change(screen.getByLabelText("Transcript path"), { target: { value: "/host/session.jsonl" } });
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Draft for this terminal")).toHaveProperty("value", "Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
  expect(screen.getByLabelText("Draft for this terminal")).toHaveProperty("value", "");
});

const antigravityRecord = {
  id: 'antigravity-record-0', role: 'record',
  record: { source: 'fixture', type: 'FUTURE_STEP', status: 'RECORDED', stepIndex: 0, exitCode: 0, errorCode: 0, truncatedFields: ['content','thinking'] },
  blocks: [{type:'text',text:'Synthetic step'}, {type:'thinking',text:'Bounded reasoning'}, {type:'tool_use',name:'Recorded tool summary',text:'{"path":"not-opened"}'}, {type:'image',text:'Attachment: view in terminal'}],
  usage: {inputTokens:'18446744073709551615',cacheReadTokens:'0'},
};
const antigravityPage = {
  schemaVersion:1,agent:'antigravity-jsonl',view:'record_stream',messages:[antigravityRecord],nextOffset:100,hasMore:true,
  checkpoint:`v1:1000:${'a'.repeat(64)}`,
};
it('opens explicit Antigravity records with literal metadata, bounded thinking, inert media and precise counters',async()=>{
  vi.mocked(invoke).mockResolvedValue(antigravityPage);const {container}=render(<ChatPanel sessionId="antigravity-host"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'antigravity-jsonl'}});
  expect(screen.getByRole('button',{name:'Find transcripts'})).toHaveProperty('disabled',true);
  expect(screen.queryByLabelText('View')).toBeNull();expect(screen.getByText(/not a reconstructed conversation/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/transcript.jsonl'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('Synthetic step');
  expect(screen.getByText(/Step 0 · Source: fixture · Type: FUTURE_STEP · Status: RECORDED/)).toBeTruthy();
  expect(screen.getByText(/Exit code: 0 · Error code: 0 · Compact truncation: content, thinking/)).toBeTruthy();
  expect(screen.getByText('Bounded reasoning').closest('details')).toBeTruthy();
  expect(screen.getByText(/inputTokens: 18446744073709551615 · cacheReadTokens: 0/)).toBeTruthy();
  expect(container.querySelector('img,iframe,script')).toBeNull();
  expect(invoke).toHaveBeenCalledWith('agent_transcript',{sessionId:'antigravity-host',agent:'antigravity-jsonl',path:'/host/transcript.jsonl',offset:0});
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='agent_transcripts')).toBe(false);
});
it('forwards the snapshot checkpoint and keeps repeated step updates as distinct physical records',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(antigravityPage).mockResolvedValueOnce({...antigravityPage,messages:[{...antigravityRecord,id:'antigravity-record-100',blocks:[{type:'text',text:'Second step update'}]}],nextOffset:200,hasMore:false});
  render(<ChatPanel sessionId="host"/>);fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'antigravity-jsonl'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/transcript.jsonl'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('Synthetic step');
  fireEvent.click(screen.getByRole('button',{name:'Load next messages'}));await screen.findByText('Second step update');
  expect(invoke).toHaveBeenLastCalledWith('agent_transcript',{sessionId:'host',agent:'antigravity-jsonl',path:'/host/transcript.jsonl',offset:100,checkpoint:antigravityPage.checkpoint});
  expect(screen.getAllByRole('heading',{name:'record'})).toHaveLength(2);
});
it('reports rewrites without mixing replacement records and reopens from zero without the old checkpoint',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(antigravityPage).mockRejectedValueOnce(new Error('lazysh-agent: TranscriptChanged: operation failed'))
    .mockResolvedValueOnce({...antigravityPage,messages:[{...antigravityRecord,blocks:[{type:'text',text:'Replacement step'}]}]});
  render(<ChatPanel sessionId="host"/>);fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'antigravity-jsonl'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/transcript.jsonl'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('Synthetic step');
  fireEvent.click(screen.getByRole('button',{name:'Load next messages'}));await screen.findByText('Transcript changed. Open it again to restart.');
  expect(screen.queryByText('Replacement step')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('Replacement step');
  expect(screen.queryByText('Synthetic step')).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('agent_transcript',{sessionId:'host',agent:'antigravity-jsonl',path:'/host/transcript.jsonl',offset:0});
});
it('rejects invalid Antigravity metadata, checkpoint boundaries and rounded or overflowing usage',()=>{
  expect(parseTranscript(antigravityPage)).toEqual(antigravityPage);
  for(const value of [
    {...antigravityPage,checkpoint:undefined}, {...antigravityPage,checkpoint:`v1:0:${'a'.repeat(64)}`},
    {...antigravityPage,checkpoint:`v1:99999999:${'a'.repeat(64)}`}, {...antigravityPage,view:'active_branch'},
    ...[{...antigravityRecord,role:'assistant'}, {...antigravityRecord,record:{...antigravityRecord.record,stepIndex:-1}},
      {...antigravityRecord,record:{...antigravityRecord.record,truncatedFields:{content:true}}},
      {...antigravityRecord,usage:{inputTokens:9007199254740992}}, {...antigravityRecord,usage:{inputTokens:'18446744073709551616'}}]
      .map(message=>({...antigravityPage,messages:[message]})),
    {...page,messages:[{...message,record:antigravityRecord.record}]},
  ]) expect(()=>parseTranscript(value)).toThrow();
});
