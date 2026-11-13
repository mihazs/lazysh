import {describe, expect, it, vi} from 'vitest';
import type {Terminal} from '@xterm/xterm';
import {configureTerminalBold} from './terminalBold';

describe('pinned DOM bold renderer lifecycle', () => {
  it('fails visibly rather than silently accepting a hex color on an unknown renderer', () => {
    expect(() => configureTerminalBold({} as Terminal, '#123456')).toThrow('cannot apply custom bold colors');
    expect(() => configureTerminalBold({} as Terminal, 'url(evil)')).toThrow('Invalid custom bold color');
    expect(() => configureTerminalBold({} as Terminal)).not.toThrow();
  });
  it('reuses one adapter, leaves non-hex drawing alone, and restores the original exactly once', () => {
    const original = vi.fn((..._args:unknown[]) => false);
    const factory = {_themeService:{colors:{background:{css:"#000000",rgba:255}}}, _applyMinimumContrast:original};
    const addons: {dispose():void}[] = [];
    const terminal = {rows:24,refresh:vi.fn(),loadAddon:(addon:{dispose():void})=>addons.push(addon),_core:{_renderService:{_renderer:{value:{_rowFactory:factory}}}}} as unknown as Terminal;
    configureTerminalBold(terminal, '#123456');
    const wrapper = factory._applyMinimumContrast;
    configureTerminalBold(terminal, '#abcdef');
    configureTerminalBold(terminal);
    expect(addons).toHaveLength(1);
    expect(factory._applyMinimumContrast).toBe(wrapper);
    factory._applyMinimumContrast({} as never);
    expect(original).toHaveBeenCalledTimes(1);
    addons[0].dispose(); addons[0].dispose();
    expect(factory._applyMinimumContrast).toBe(original);
  });
  it('does not clobber another owner and becomes inert if that owner retains its wrapper', () => {
    const original = vi.fn((..._args:unknown[]) => false);
    const factory = {_themeService:{colors:{background:{css:'#000000',rgba:255}}},_applyMinimumContrast:original};
    const addons:{dispose():void}[]=[];
    const terminal={rows:24,refresh:vi.fn(),loadAddon:(addon:{dispose():void})=>addons.push(addon),_core:{_renderService:{_renderer:{value:{_rowFactory:factory}}}}} as unknown as Terminal;
    configureTerminalBold(terminal,'#123456');
    const installed=factory._applyMinimumContrast;
    const next=(...args:unknown[])=>installed(...args);
    factory._applyMinimumContrast=next as typeof original;
    addons[0].dispose();addons[0].dispose();
    expect(factory._applyMinimumContrast).toBe(next);
    expect(factory._applyMinimumContrast()).toBe(false);
    expect(original).toHaveBeenCalledTimes(1);
  });

});
