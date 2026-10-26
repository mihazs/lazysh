// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {isPermissionGranted, onAction, registerActionTypes, requestPermission} from '@tauri-apps/plugin-notification';
import ChatPanel, {parseTranscript} from '../ChatPanel';
import UsagePanel, {parseUsage} from '../UsagePanel';
import NotificationPanel, {NotificationMonitor} from '../NotificationPanel';
import {getInbox, updateInbox} from '../notificationStore';
import {formatDateTime, uiI18n} from './core';
import {accessSnapshot, acknowledgeAccessReady, applyAccessStatus} from '../access';
vi.mock('@tauri-apps/api/core',async original=>({...await (await import('../test/nativeCoreMock')).mockNativeCore(original),isTauri:()=>true}));
vi.mock('@tauri-apps/plugin-notification',()=>({isPermissionGranted:vi.fn(),requestPermission:vi.fn(),registerActionTypes:vi.fn().mockResolvedValue(undefined),onAction:vi.fn().mockResolvedValue({unregister:vi.fn()})}));
import {panelRawText as original,panelTimestamp as timestamp,panelSession as session,recordedTranscript as transcript,recordedUsage as usage,panelInboxRow} from '../test/recordedPanelData';
beforeEach(()=>{
  localStorage.clear();
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:"Synthetic locale fixture",generation:String(BigInt(accessSnapshot().status?.generation ?? "0")+1n),nonce:"a".repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  updateInbox({version:1,monitoring:false,notifications:false,rows:[],latest:{},error:''});
  vi.mocked(isPermissionGranted).mockResolvedValue(false);vi.mocked(requestPermission).mockResolvedValue('granted');
});
afterEach(async()=>{cleanup();vi.clearAllMocks();await uiI18n.changeLanguage('en');});
it.each([
  {locale:'pt-BR',chatPath:'Caminho da transcrição',open:'Abrir transcrição',refresh:'Atualizar novas mensagens',reading:'Lendo…',draft:'Rascunho para este terminal',stage:'Preparar no terminal',staged:'Revise este rascunho no terminal antes de colá-lo.',usageAgent:'Agente dos dados de uso',usagePath:'Caminho da transcrição de uso',inspect:'Inspecionar uso',input:'Tokens de entrada',toolError:'Erro registrado da ferramenta',enable:'Ativar notificações do sistema',archive:'Arquivar',openConnected:'Abrir sessão conectada',openAction:'Abrir sessão',invalid:'Resposta de transcrição inválida.',invalidUsage:'Resposta de uso incompatível. Atualize o companion do servidor.',minute:'1 minuto'},
  {locale:'es',chatPath:'Ruta de la transcripción',open:'Abrir transcripción',refresh:'Actualizar mensajes nuevos',reading:'Leyendo…',draft:'Borrador para este terminal',stage:'Preparar en el terminal',staged:'Revisa este borrador en el terminal antes de pegarlo.',usageAgent:'Agente de los datos de uso',usagePath:'Ruta de la transcripción de uso',inspect:'Inspeccionar uso',input:'Tokens de entrada',toolError:'Error registrado de la herramienta',enable:'Activar notificaciones del sistema',archive:'Archivar',openConnected:'Abrir sesión conectada',openAction:'Abrir sesión',invalid:'Respuesta de transcripción no válida.',invalidUsage:'Respuesta de uso no compatible. Actualiza el companion del servidor.',minute:'1 minuto'},
])('translates $locale actions without replacing drafts, requests, opaque records or original authority',async labels=>{
  await uiI18n.changeLanguage(labels.locale);
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_transcript'?transcript:command==='agent_usage'?usage:undefined);
  updateInbox({rows:[panelInboxRow]});  const staged=vi.fn();const opened=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);window.addEventListener('lazysh-inbox-open',opened);
  try {
    const view=render(<><ChatPanel sessionId={session.id}/><UsagePanel sessionId={session.id}/><NotificationMonitor sessions={[session]}/><NotificationPanel sessions={[session]}/></>);
    expect(invoke).not.toHaveBeenCalled();expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(labels.chatPath),{target:{value:'/raw/session.jsonl'}});
    fireEvent.click(screen.getByRole('button',{name:labels.open}));
    await screen.findByText(new RegExp(labels.toolError));
    expect(screen.getByText(JSON.stringify({argument:original}))).toBeTruthy();
    expect(view.container.querySelector('img,script')).toBeNull();
    let release!: (value:unknown)=>void;
    vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    fireEvent.click(screen.getByRole('button',{name:labels.refresh}));
    await screen.findByRole('button',{name:labels.reading});
    await act(async()=>{await uiI18n.changeLanguage('en');});
    expect(screen.getByRole('button',{name:'Reading…'})).toBeTruthy();
    await act(async()=>{await uiI18n.changeLanguage(labels.locale);});
    expect(screen.getByRole('button',{name:labels.reading})).toBeTruthy();
    await act(async()=>{release(transcript);});
    await screen.findByRole('button',{name:labels.refresh});
    fireEvent.change(screen.getByLabelText(labels.usageAgent),{target:{value:'codex'}});
    fireEvent.change(screen.getByLabelText(labels.usagePath),{target:{value:'/raw/usage.jsonl'}});
    fireEvent.click(screen.getByRole('button',{name:labels.inspect}));
    await screen.findByText(labels.minute);
    const metric=screen.getByText(labels.input).parentElement!;
    expect(metric.querySelector('dd')?.textContent).toBe('12.500');
    expect([...view.container.querySelectorAll('time')].every(element=>element.dateTime===timestamp)).toBe(true);
    expect([...view.container.querySelectorAll('time')].some(element=>element.textContent===formatDateTime(new Date(timestamp)))).toBe(true);
    const draft=screen.getByLabelText(labels.draft);fireEvent.change(draft,{target:{value:original}});
    fireEvent.click(screen.getByRole('button',{name:labels.stage}));
    expect(await screen.findByText(labels.staged)).toBeTruthy();
    expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:session.id,text:original});
    fireEvent.click(screen.getByRole('button',{name:labels.openConnected}));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:session.id});
    fireEvent.click(screen.getByRole('button',{name:labels.enable}));
    await waitFor(()=>expect(requestPermission).toHaveBeenCalledOnce());
    await waitFor(()=>expect(registerActionTypes).toHaveBeenCalledOnce());
    expect(registerActionTypes).toHaveBeenCalledWith([{id:'lazysh-agent',actions:[{id:'open-session',title:labels.openAction,foreground:true}]}]);
    const requests=vi.mocked(invoke).mock.calls.length;
    await act(async()=>{await uiI18n.changeLanguage('en');});
    expect(screen.getByLabelText('Draft for this terminal')).toBe(draft);expect((draft as HTMLTextAreaElement).value).toBe(original);
    expect(screen.getByText('Input tokens').parentElement).toBe(metric);expect(metric.querySelector('dd')?.textContent).toBe('12,500');
    expect(screen.getByText('Review this draft in the terminal before pasting it.')).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(requests);expect(registerActionTypes).toHaveBeenCalledOnce();expect(onAction).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['agent_transcript','agent_transcript','agent_usage']);
    for(const call of vi.mocked(invoke).mock.calls) expect(call[2]).toEqual({headers:{'X-Lazysh-Access':'a'.repeat(64)}});
    await act(async()=>{await uiI18n.changeLanguage(labels.locale);});
    fireEvent.click(screen.getByRole('button',{name:labels.archive}));expect(getInbox().rows).toHaveLength(0);
    expect(()=>parseTranscript(null)).toThrow(labels.invalid);expect(()=>parseUsage(null)).toThrow(labels.invalidUsage);
  } finally {window.removeEventListener('lazysh-prompt-draft',staged);window.removeEventListener('lazysh-inbox-open',opened);}
});
