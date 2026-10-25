import type { Terminal } from '@xterm/xterm';
import {terminalOptions,terminalBoldColor,type Preferences} from './preferences';

export function applyTerminalTheme(terminal: Terminal, preferences: Preferences, fontFamily?: string) {
  configureTerminalBold(terminal, terminalBoldColor(preferences));
  terminal.options = terminalOptions(preferences, fontFamily);
}


// xterm 5.5.0 DOM-only seam: resolve default bold color before its existing
// contrast/selection pipeline, without changing any buffer or work-cell attributes.
type Color = {css: string; rgba: number};
type Cell = {isBold(): number; isFgDefault(): boolean; isBgDefault(): boolean; isInverse(): number; isDim(): number};
type Contrast = (element: HTMLElement, background: Color, foreground: Color, cell: Cell, backgroundOverride?: Color, foregroundOverride?: Color) => boolean;
type RowFactory = {_applyMinimumContrast: Contrast; _themeService: {colors: {background: Color}}};
type Renderer = {_rowFactory?: RowFactory};
type Hook = {renderer: Renderer; color?: Color; dispose(): void};
const hooks = new WeakMap<Terminal, Hook>();
const unsupported = () => new Error('This terminal cannot apply custom bold colors.');
const half = (color: Color): Color => ({css: color.css + '80', rgba: ((color.rgba & 0xffffff00) | 0x80) >>> 0});

export function configureTerminalBold(terminal: Terminal, color?: string): void {
  if (color !== undefined && !/^#[\da-f]{6}$/i.test(color)) throw new Error('Invalid custom bold color.');
  const bold = color === undefined ? undefined : {css: color, rgba: Number.parseInt(color.slice(1) + 'ff', 16)};
  let hook = hooks.get(terminal);
  if (!bold && !hook) return;
  const renderer = (terminal as unknown as {_core?: {_renderService?: {_renderer?: {value?: Renderer}}}})._core?._renderService?._renderer?.value;
  if (hook && hook.renderer !== renderer) {hook.dispose(); hook = undefined;}
  if (hook) {
    if (hook.color?.css !== bold?.css) {hook.color = bold; terminal.refresh(0, terminal.rows - 1);}
    return;
  }
  if (!bold) return;
  const factory = renderer?._rowFactory;
  const background = factory?._themeService?.colors?.background;
  if (!renderer || !factory || typeof factory._applyMinimumContrast !== 'function' || typeof background?.css !== 'string' || !Number.isInteger(background.rgba)) throw unsupported();
  const original = factory._applyMinimumContrast;
  const injectedBackgrounds = new WeakSet<HTMLElement>();
  let disposed = false;
  const wrapper: Contrast = function(element, bg, fg, cell, bgOverride, fgOverride) {
    const active = hook!.color;
    if (disposed || !active || !cell.isBold() || !cell.isFgDefault()) return original.call(factory, element, bg, fg, cell, bgOverride, fgOverride);
    if (cell.isInverse()) {
      // An explicit decoration/selection background is already inline. Only
      // replace the original logical foreground when it becomes inverse background.
      if (!element.style.backgroundColor || injectedBackgrounds.has(element)) {
        element.style.backgroundColor = active.css;
        injectedBackgrounds.add(element);
        bg = active;
        if (bgOverride) bgOverride = half(active); // xterm's dim-only contrast background.
      }
      if (!fgOverride && cell.isBgDefault()) fg = factory._themeService.colors.background;
      return original.call(factory, element, bg, fg, cell, bgOverride, fgOverride);
    }
    if (fgOverride) return original.call(factory, element, bg, fg, cell, bgOverride, fgOverride);
    if (!original.call(factory, element, bg, active, cell, bgOverride, fgOverride)) {
      element.style.color = cell.isDim() ? half(active).css : active.css;
    }
    // Prevent the default foreground branch from replacing this resolved color.
    return true;
  };
  hook = {renderer, color: bold, dispose() {
    if (disposed) return;
    disposed = true;
    if (factory._applyMinimumContrast === wrapper) factory._applyMinimumContrast = original;
    hooks.delete(terminal);
  }};
  factory._applyMinimumContrast = wrapper;
  hooks.set(terminal, hook);
  terminal.loadAddon({activate() {}, dispose: hook.dispose});
  terminal.refresh(0, terminal.rows - 1);
}
