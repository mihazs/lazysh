// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import ChatPanel, { parseTranscript } from "./ChatPanel";
import {readFileSync} from 'node:fs';

vi.mock("@tauri-apps/api/core", async original => (await import("./test/nativeCoreMock")).mockNativeCore(original));
afterEach(cleanupNativeMocks);

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
it('admits returned image bytes only in supported recorded image contexts and rejects malformed previews',()=>{
  const imagePreview={mimeType:'image/png',data:readFileSync('e2e/fixtures/recorded-images/regions.png').toString('base64'),width:32,height:16};
  const block={type:'image',text:'Image attachment',imagePreview};
  const response={...page,agent:'grok-acp',view:'record_stream',messages:[{...message,blocks:[block]}]};
  expect(parseTranscript(response)).toEqual(response);
  for(const view of ['record_stream','active_branch']) {
    const claude={...response,agent:'claude',view,messages:[{...message,role:'user',blocks:[block]}]};
    expect(parseTranscript(claude)).toEqual(claude);
    for(const role of ['assistant','tool'])expect(()=>parseTranscript({...claude,messages:[{...message,role,blocks:[block]}]})).toThrow('Invalid recorded-image preview response.');
  }
  for(const invalid of [
    {...response,agent:'claude'}, {...response,view:'active_branch'},
    {...response,messages:[{...message,role:'tool',blocks:[block]}]},
    ...[{...block,type:'text'},{...block,id:'tool-call'},{...block,status:'completed'},
      {...block,imagePreview:{...imagePreview,width:16,height:32}}].map(value=>({...response,messages:[{...message,blocks:[value]}]})),
  ])expect(()=>parseTranscript(invalid)).toThrow('Invalid recorded-image preview response.');
});
it('validates Claude-only boolean tool errors and renders recorded failures without changing output',async()=>{
  const blocks=[{type:'tool_result',id:'failed-call',text:'Permission denied',isError:true},
    {type:'tool_result',id:'ok-call',text:'Original success',isError:false},
    {type:'tool_result',id:'unknown-call',text:'Unknown outcome'},
    {type:'tool_result',id:'empty-call',text:'',isError:true}];
  const response={...page,messages:[{...message,blocks}]};
  expect(parseTranscript(response)).toEqual(response);
  for(const value of [null,'false',0,{},[]])expect(()=>parseTranscript({...page,messages:[{...message,blocks:[{...blocks[0],isError:value}]}]})).toThrow('Invalid recorded tool error');
  for(const type of ['text','thinking','tool_use','image'])expect(()=>parseTranscript({...page,messages:[{...message,blocks:[{...blocks[0],type}]}]})).toThrow('Invalid recorded tool error');
  expect(()=>parseTranscript({...response,agent:'qoder-ide'})).toThrow('Invalid recorded tool error');
  vi.mocked(invoke).mockResolvedValue(response);
  render(<ChatPanel sessionId="claude-host"/>);
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/claude.jsonl'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
  expect(await screen.findByText(/Recorded tool error · Tool ID: failed-call/)).toBeTruthy();
  expect(screen.getByText(/Recorded tool error · Tool ID: empty-call/)).toBeTruthy();
  expect(screen.getByText('Permission denied')).toBeTruthy();
  expect(screen.getByText('Original success')).toBeTruthy();
  expect(screen.getAllByText(/Recorded tool error/)).toHaveLength(2);
  expect(screen.queryByRole('button',{name:/approve|deny|stop|retry/i})).toBeNull();
});
it('renders Grok statuses as recorded tool metadata without claiming live state or inventing output',async()=>{
  const blocks=[{type:'tool_use',id:'call',name:'Inspect source',text:'{"path":"not-read"}',status:'in_progress'},
    {type:'tool_result',id:'call',name:'Tool status',text:'Recorded tool status: failed',status:'failed'},
    {type:'tool_result',id:'call',text:'Original output',status:'completed'},
    {type:'image',id:'call',text:'Attachment: view in terminal',status:'pending'}];
  vi.mocked(invoke).mockResolvedValue({...page,agent:'grok-acp',view:'record_stream',messages:[{...message,blocks}]});
  render(<ChatPanel sessionId="grok-host"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'grok-acp'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/updates.jsonl'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
  for(const status of ['pending','in_progress','completed','failed'])expect(await screen.findByText(new RegExp(`Recorded status: ${status}`))).toBeTruthy();
  expect(screen.getByText('Original output')).toBeTruthy();
  expect(screen.getByText('Recorded tool status: failed')).toBeTruthy();
  expect(screen.getByText('{"path":"not-read"}')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/approve|deny|stop|send/i})).toBeNull();
  expect(screen.queryByLabelText('Follow selected Claude branch')).toBeNull();
});
it('rejects unrecognized or unlinked status metadata and accepts old blocks without status',()=>{
  const block={type:'tool_result',id:'call',text:'Output',status:'failed'};
  const response={...page,agent:'grok-acp',view:'record_stream',messages:[{...message,blocks:[block]}]};
  expect(parseTranscript(response)).toEqual(response);
  for(const invalid of [null,42,'working','',{},'x'.repeat(300)])expect(()=>parseTranscript({...response,messages:[{...message,blocks:[{...block,status:invalid}]}]})).toThrow('Invalid recorded tool status');
  for(const invalid of [{...block,id:undefined},{...block,id:''},{...block,id:'x'.repeat(257)},{...block,id:'😀'.repeat(65)},{...block,type:'text'},{...block,type:'thinking'}])expect(()=>parseTranscript({...response,messages:[{...message,blocks:[invalid]}]})).toThrow();
  expect(()=>parseTranscript({...response,messages:[{...message,blocks:[{...block,id:'😀'.repeat(64)}]}]})).not.toThrow();
  expect(()=>parseTranscript({...response,agent:'claude'})).toThrow();
  expect(parseTranscript(page)).toEqual(page);
});

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

it("retains explicit Grok file reads without automatic discovery or conversation claims", async () => {
  const grok = { ...page, agent: "grok-acp", view: "record_stream" };
  expect(parseTranscript(grok)).toEqual(grok);
  expect(() => parseTranscript({ ...grok, view: "future_view" })).toThrow();
  expect(() => parseTranscript({ ...grok, view: undefined })).toThrow();
  vi.mocked(invoke).mockResolvedValue(grok);
  render(<ChatPanel sessionId="grok-host" />);
  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "grok-acp" },
  });
  expect(
    screen.getByRole("button", { name: "Find transcripts" }),
  ).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("View")).toHaveProperty("value","records");
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
  }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(
    vi.mocked(invoke).mock.calls.some(([name]) => name === "agent_transcripts"),
  ).toBe(false);
});

function openHostTranscript(view?: string) {
  const rendered = render(<ChatPanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText("Transcript path"), { target: { value: "/host/session.jsonl" } });
  if (view) fireEvent.change(screen.getByLabelText("View"), { target: { value: view } });
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  return rendered;
}

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
  const { container } = openHostTranscript();
  await screen.findByText("[Image — view in terminal]");
  expect(container.querySelector("img, script, iframe")).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("agent_transcript", {
    sessionId: "ssh1",
    agent: "claude",
    path: "/host/session.jsonl",
    offset: 0,
  }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh new messages" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("agent_transcript", {
      sessionId: "ssh1",
      agent: "claude",
      path: "/host/session.jsonl",
      offset: 80,
    }, { headers: { "X-Lazysh-Access": expect.any(String) } }),
  );
  expect(await screen.findByText("world")).toBeTruthy();
});

it("rejects a non-advancing pagination cursor", async () => {
  vi.mocked(invoke).mockResolvedValue({
    ...page,
    nextOffset: 0,
    hasMore: true,
  });
  openHostTranscript();
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
  openHostTranscript("conversation");
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
  }, { headers: { "X-Lazysh-Access": expect.any(String) } });
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
  expect(invoke).toHaveBeenCalledWith('agent_transcript',{sessionId:'antigravity-host',agent:'antigravity-jsonl',path:'/host/transcript.jsonl',offset:0}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='agent_transcripts')).toBe(false);
});
it('forwards the snapshot checkpoint and keeps repeated step updates as distinct physical records',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(antigravityPage).mockResolvedValueOnce({...antigravityPage,messages:[{...antigravityRecord,id:'antigravity-record-100',blocks:[{type:'text',text:'Second step update'}]}],nextOffset:200,hasMore:false});
  render(<ChatPanel sessionId="host"/>);fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'antigravity-jsonl'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/transcript.jsonl'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('Synthetic step');
  fireEvent.click(screen.getByRole('button',{name:'Load next messages'}));await screen.findByText('Second step update');
  expect(invoke).toHaveBeenLastCalledWith('agent_transcript',{sessionId:'host',agent:'antigravity-jsonl',path:'/host/transcript.jsonl',offset:100,checkpoint:antigravityPage.checkpoint}, { headers: { "X-Lazysh-Access": expect.any(String) } });
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
  expect(invoke).toHaveBeenLastCalledWith('agent_transcript',{sessionId:'host',agent:'antigravity-jsonl',path:'/host/transcript.jsonl',offset:0}, { headers: { "X-Lazysh-Access": expect.any(String) } });
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
it('lists Grok metadata only and requires explicit selection and opening through the record reader',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({schemaVersion:1,agent:'grok-acp',sessions:[{path:'/host/.grok/sessions/cwd/id/updates.jsonl',name:'id',bytes:100,modifiedAt:'2026-10-26T00:00:00Z'}]});
  render(<ChatPanel sessionId="grok-discovery"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'grok-acp'}});
  fireEvent.click(screen.getByRole('button',{name:'Find transcripts'}));
  const picker=await screen.findByLabelText('Recent transcripts');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('agent_transcripts',{sessionId:'grok-discovery',agent:'grok-acp'},{headers:{'X-Lazysh-Access':expect.any(String)}});
  fireEvent.change(picker,{target:{value:'0'}});
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Transcript path')).toHaveProperty('value','/host/.grok/sessions/cwd/id/updates.jsonl');
  vi.mocked(invoke).mockResolvedValueOnce({...page,agent:'grok-acp',view:'record_stream'});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
  await screen.findByText('world');
  expect(invoke).toHaveBeenLastCalledWith('agent_transcript',{sessionId:'grok-discovery',agent:'grok-acp',path:'/host/.grok/sessions/cwd/id/updates.jsonl',offset:0},{headers:{'X-Lazysh-Access':expect.any(String)}});
  expect(screen.getByLabelText('View')).toHaveProperty('value','records');
  expect(screen.queryByRole('checkbox',{name:'Follow selected Claude branch'})).toBeNull();
});
it('rejects malformed Grok discovery metadata without opening any record file',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({schemaVersion:1,agent:'grok-acp',sessions:[{path:4,name:'unsafe'}]});
  render(<ChatPanel sessionId="grok-invalid"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'grok-acp'}});
  fireEvent.click(screen.getByRole('button',{name:'Find transcripts'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Invalid transcript list.');
  expect(invoke).toHaveBeenCalledTimes(1);
});
