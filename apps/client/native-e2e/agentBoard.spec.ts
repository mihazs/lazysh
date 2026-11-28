import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {cards,hook,openActivity,report,reportAll,settle,type HostReports} from './agentBoardUi';
import {openOwnedSsh,ownedCompanionSsh,ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
const HOST='Owned SSH GUI host';

it('renders real companion hook events as one board row per session grouped by project and puts a pending approval above them',async()=>{
  const {ssh,companion}=await ownedCompanionSsh(fixture);
  const gui=fixture.gui=await NativeGui.start();
  const {browser}=await openOwnedSsh(gui,ssh);
  fixture.captureSafe=true;
  const prompt={hook_event_name:'UserPromptSubmit'},tool={hook_event_name:'PreToolUse',tool_name:'Bash'};

  gui.stage='owned board hook events';
  const events:HostReports=[
    ['%3','board-alpha','/work/alpha',[prompt,tool,{hook_event_name:'Notification',notification_type:'permission_prompt'}]],
    ['%4','board-beta','/work/alpha',[prompt,tool,tool]],
    ['%5','board-delta','/work/alpha',[prompt]],
    ['%6','board-gamma','/work/docs',[prompt,{hook_event_name:'Stop'}]],
  ];
  await reportAll(ssh,companion,events);

  gui.stage='owned board activity';
  const panel=await openActivity(browser);
  const read=(state:string,selector:string,attribute?:string)=>browser.execute((state:string,selector:string,attribute?:string)=>
    Array.from(document.querySelectorAll(`section.agent-panel:not([hidden]) section.agent-column[data-state="${state}"] ${selector}`),node=>attribute?node.getAttribute(attribute):node.textContent),state,selector,attribute);
  const summaries=(state:string)=>read(state,'.agent-row-summary');
  const groups=(state:string)=>read(state,'section.agent-project-group','aria-label');

  await settle(browser,'every reported session',async()=>await cards(browser)===4);
  // Newest report first within a state; one row per session however many events it reported.
  expect(await summaries('needs_attention')).toEqual(['Agent needs attention']);
  expect(await summaries('working')).toEqual(['Working on your prompt','Bash']);
  expect(await summaries('done')).toEqual(['Turn finished']);
  expect(await groups('working')).toEqual([`alpha on ${HOST}`]);
  expect(await groups('done')).toEqual([`docs on ${HOST}`]);
  expect(await (await panel.$('.agent-board')).getText()).not.toMatch(/PRIVATE-PROMPT|SECRET-TOKEN/);
  await (await panel.$('section.agent-column[data-state="needs_attention"] button[aria-label="View Claude Code report for /work/alpha"]')).click();
  const selected=await panel.$('section.agent-selected-report');await selected.waitForDisplayed();
  await (await selected.$('summary')).click();
  const details=await (await selected.$('details')).getText();
  // The three events of this session are one row; WebKit joins the term and its value without a separator.
  expect(details).toMatch(/board-alpha\s*Reported events\s*3\s*Reported pane ID\s*%3/);
  await (await selected.$('button.agent-report-back')).click();

  gui.stage='owned board latest event';
  await report(ssh,companion,'%4','board-beta','/work/alpha',{hook_event_name:'Stop'});
  await settle(browser,'the finished session in Done',async()=>(await summaries('done')).length===2);
  expect(await summaries('working')).toEqual(['Working on your prompt']);
  expect(await cards(browser)).toBe(4);

  gui.stage='owned board approval';
  const waiting=await hook(ssh,companion,'approval-request --agent claude --timeout-seconds 90','%9',{hook_event_name:'PermissionRequest',session_id:'board-approval',cwd:'/work/gated',tool_name:'Bash',tool_input:{command:'git push --force-with-lease'}});
  // An empty approval panel renders nothing, so the card itself is what the poll brings.
  const card=await browser.$('section.approval-panel article.approval-card');
  await card.waitForDisplayed({timeout:30_000,timeoutMsg:'Owned approval was not listed'});
  expect(await (await card.$('h4')).getText()).toBe('claude · Bash');
  expect(await card.getText()).toContain('git push --force-with-lease');
  expect(await card.$('dl').then(facts=>facts.getText())).toMatch(/\/work\/gated[\s\S]*board-approval[\s\S]*%9/);
  // Approvals come before the board in the page, and the waiting hook put its session in Needs you.
  expect(await browser.execute(()=>{
    const first=document.querySelector('section.approval-panel'),second=document.querySelector('.agent-board');
    return !!first && !!second && !!(first.compareDocumentPosition(second)&Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await settle(browser,'the waiting session in Needs you',async()=>(await summaries('needs_attention')).includes('Bash'));

  gui.stage='owned board approval decision';
  await (await card.$('button=Allow this request')).click();
  const answer=JSON.parse(await waiting.finish('owned approval hook decision',20_000));
  expect(answer.hookSpecificOutput.decision).toEqual({behavior:'allow'});
  await card.waitForDisplayed({reverse:true,timeout:20_000});
  expect(gui.connections).toBe(0);
},240_000);
