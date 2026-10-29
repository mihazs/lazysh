import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
import {agentApproval,agentBoardRecord,agentBoardSession} from '../src/test/agentBoardData';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}
for(const locale of ['pt-BR','es','en'])test(`${locale} agent board preserves drafts and binds a held decision to its original target`,async({page})=>{
  const external=await openLocalizedApp(page,locale);
  await page.evaluate(async()=>{const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');window.agentBoard=mountAgentBoard();});
  const root=page.locator('.agent-board-fixture');const card=root.locator('.agent-card');const request=root.locator('.approval-panel article');
  await expect(card).toContainText(agentBoardRecord.summary);await expect(request.locator('pre')).toHaveText(JSON.stringify(agentApproval().toolInput,null,2));
  const usageLabel=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return t('companionUsage');});const usage=root.getByRole('checkbox',{name:usageLabel,exact:true});await usage.uncheck();await usage.focus();
  const originalCard=await card.elementHandle();const originalSwitch=await usage.elementHandle();const originalRequest=await request.elementHandle();
  const commandsBefore=await page.evaluate(()=>window.agentBoard.calls);
  for(const language of ['es','pt-BR','en']){
    await page.evaluate(async language=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:language as 'es'|'pt-BR'|'en'});},language);
    const labels=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return {agents:t('agentsTitle'),settings:t('companionSettingsTitle'),needs:t('agentsNeedsYou'),usage:t('companionUsage')};});
    await expect(root.getByRole('region',{name:labels.settings,exact:true})).toBeVisible();await expect(root.getByRole('region',{name:labels.needs,exact:true})).toBeVisible();
    expect(await originalCard!.evaluate(node=>node.isConnected)).toBe(true);expect(await originalRequest!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await originalSwitch!.evaluate(node=>node===document.activeElement)).toBe(true);await expect(root.getByRole('checkbox',{name:labels.usage,exact:true})).not.toBeChecked();
    expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(()=>window.agentBoard.calls)).toEqual(commandsBefore);
  const approval=root.getByRole('button',{name:'Allow this request',exact:true});await approval.click();
  await expect(approval).toBeDisabled();await expect(root.getByRole('button',{name:'Deny request',exact:true})).toBeDisabled();
  await page.evaluate(async()=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:'pt-BR'});});
  await expect(root.getByRole('button',{name:'Permitir esta solicitação',exact:true})).toBeDisabled();
  const calls=await page.evaluate(()=>window.agentBoard.calls);const decisions=calls.filter(call=>call.command==='resolve_agent_approval');
  expect(decisions).toHaveLength(1);expect(decisions[0].args).toEqual({sessionId:agentBoardSession,id:agentApproval().id,expectedHash:'a'.repeat(64),agentSessionId:agentBoardRecord.sessionId,paneId:agentBoardRecord.paneId,decision:'allow'});
  expect(await root.textContent()).not.toContain('a'.repeat(64));expect(await root.textContent()).not.toContain('c'.repeat(64));expect(await root.locator('img,script').count()).toBe(0);
  await page.evaluate(()=>window.agentBoard.complete());await expect(request).toHaveCount(0);expect(await originalSwitch!.evaluate(node=>(node as HTMLInputElement).checked)).toBe(false);
  await root.getByRole('button',{name:'Salvar configurações do servidor',exact:true}).click();await expect(root.locator('.form-stack').locator('..').getByRole('status')).toHaveText('Configurações do servidor salvas para novas operações.');
  expect((await page.evaluate(()=>window.agentBoard.calls)).find(call=>call.command==='update_companion_settings')?.args).toEqual({sessionId:agentBoardSession,settings:{expectedRevision:7,transcriptDiscoveryEnabled:true,recordedUsageEnabled:false,deviceToolsEnabled:true}});
  await page.evaluate(async()=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:'es'});});await expect(root.locator('.form-stack').locator('..').getByRole('status')).toHaveText('Configuración del servidor guardada para nuevas operaciones.');
  expect(await card.locator('time').getAttribute('datetime')).toBe(agentBoardRecord.updatedAt);expect(external).toEqual([]);
});

for(const locale of ['en','pt-BR','es'])test(`${locale} reported discovery keeps search and approval ownership separate`,async({page},testInfo)=>{
  await openLocalizedApp(page,locale);
  await page.evaluate(async()=>{
    const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');
    const {agentBoardRecord}=await import('/src/test/agentBoardData.ts');
    window.agentBoard=mountAgentBoard();
    window.agentBoard.setReports([agentBoardRecord,{...agentBoardRecord,sessionId:'other-report',agent:'Codex',state:'working',project:'/api',summary:'Implement parser'},{...agentBoardRecord,sessionId:'finished-report',agent:'Gemini',state:'done',project:'/docs',summary:'Published guide'}]);
  });
  const root=page.locator('.agent-board-fixture');
  const labels=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return {search:t('agentsSearch'),status:t('agentsFilterStatus'),all:t('agentsAll'),working:t('agentsWorking'),details:t('agentsDetails'),selected:t('agentsSelectedReport'),clear:t('agentsClearFilters')};});
  await expect(root.locator('.agent-card')).toHaveCount(3);
  const search=root.getByRole('searchbox');
  await expect(search).toHaveAccessibleName(labels.search);
  const filters=root.getByRole('group',{name:labels.status,exact:true});
  await expect(filters.getByRole('button',{name:`${labels.all} 3`,exact:true})).toHaveAttribute('aria-pressed','true');
  await root.locator('.agent-card').filter({hasText:agentBoardRecord.summary}).getByRole('button',{name:/./}).first().click();
  const context=root.getByRole('region',{name:labels.selected,exact:true});
  await expect(context).toContainText(agentBoardRecord.paneId);
  await expect(context.getByRole('button',{name:/jump|attach/i})).toHaveCount(0);
  const approval=root.locator('.approval-panel article');const original=await approval.elementHandle();
  const callsBefore=await page.evaluate(()=>window.agentBoard.calls);
  await search.fill('PARSER');await search.focus();const input=await search.elementHandle();
  await expect(root.locator('.agent-card')).toHaveCount(1);await expect(root.locator('.agent-card')).toContainText('Codex');
  await expect(context).toHaveCount(0);
  for(const language of ['pt-BR','es','en']) {
    await page.evaluate(async language=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:language as 'en'|'pt-BR'|'es'});},language);
    expect(await input!.evaluate(node=>node===document.activeElement)).toBe(true);
    await expect(root.getByRole('searchbox')).toHaveValue('PARSER');
  }
  expect(await page.evaluate(()=>window.agentBoard.calls)).toEqual(callsBefore);
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  await root.getByRole('button',{name:'Clear filters',exact:true}).click();
  await root.getByRole('group',{name:'Reported status',exact:true}).getByRole('button',{name:'Working 1',exact:true}).click();
  await expect(root.locator('.agent-card')).toHaveCount(1);await expect(approval).toContainText(agentBoardRecord.agent);
  await root.getByRole('button',{name:'Allow this request',exact:true}).click();
  const decisions=(await page.evaluate(()=>window.agentBoard.calls)).filter(call=>call.command==='resolve_agent_approval');
  expect(decisions).toHaveLength(1);expect(decisions[0].args).toMatchObject({sessionId:agentBoardSession,agentSessionId:agentBoardRecord.sessionId,paneId:agentBoardRecord.paneId,expectedHash:'a'.repeat(64)});
  await search.fill('no matching report');await expect(root.getByText('No matching reported agents', {exact:true})).toBeVisible();
  await root.getByRole('button',{name:'Clear filters',exact:true}).click();
  await root.locator('.agent-card').filter({hasText:agentBoardRecord.summary}).getByRole('button').first().click();
  await root.getByRole('searchbox').scrollIntoViewIfNeeded();
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('reported-agent-discovery.png')});
  expect(await root.locator('img,script').count()).toBe(0);
});
