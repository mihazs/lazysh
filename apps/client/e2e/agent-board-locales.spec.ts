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
