/**
 * Computed-style audits for the shared visual system. They read what the browser
 * actually paints, so a regression from any stylesheet (or inline style) shows up.
 */
export type DesignAudit = {
  /** Visible controls whose computed border is painted with a non-transparent colour. */
  borderedControls: {control: string; border: string}[];
  /** Painted colours in the cyan/teal hue family, outside the user's terminal palette. */
  cyan: {element: string; property: string; color: string}[];
};

export function designAudit(root: Element = document.body): DesignAudit {
  const context = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#000';
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  const cyanish = (color: string) => {
    if (!color || color === 'none' || color === 'transparent' || color.startsWith('url(')) return false;
    const [r, g, b, a] = rgba(color);
    if (a < 26) return false;
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, lightness = (max + min) / 2, delta = max - min;
    if (delta < .08) return false;
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue = 0;
    if (max === r / 255) hue = 60 * (((g - b) / 255 / delta) % 6);
    else if (max === g / 255) hue = 60 * ((b - r) / 255 / delta + 2);
    else hue = 60 * ((r - g) / 255 / delta + 4);
    if (hue < 0) hue += 360;
    return hue >= 160 && hue <= 200 && saturation > .25;
  };
  const name = (node: Element) => `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\s+/).join('.') : ''} "${(node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 40)}"`;
  const visible = (node: Element) => node.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) && node.getClientRects().length > 0;
  const borderedControls: DesignAudit['borderedControls'] = [];
  const cyan: DesignAudit['cyan'] = [];
  const controls = 'button, select, textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden])';
  for (const control of root.querySelectorAll(controls)) {
    // The terminal's own helper textarea belongs to xterm and paints nothing.
    if (control.closest('.xterm') || !visible(control)) continue;
    const style = getComputedStyle(control);
    const painted = (['Top', 'Right', 'Bottom', 'Left'] as const).filter(side =>
      parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
      && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none'
      && rgba(style.getPropertyValue(`border-${side.toLowerCase()}-color`))[3] > 0);
    if (painted.length) borderedControls.push({control: name(control), border: `${painted.join('/')} ${style.borderTopWidth} ${style.borderTopColor}`});
  }
  // The shared accent tokens themselves, even where no element paints them right now.
  const tokens = getComputedStyle(document.documentElement);
  for (const token of ['--accent', '--theme-accent', '--ui-focus-ring', '--ui-fill-selected'])
    if (cyanish(tokens.getPropertyValue(token).trim())) cyan.push({element: ':root', property: token, color: tokens.getPropertyValue(token)});
  for (const node of [root, ...root.querySelectorAll('*')]) {
    // The user's terminal theme and the brand mark artwork are not accents.
    if (node.closest('.xterm') || node.closest('.theme-preview') || node.tagName === 'IMG' || !visible(node)) continue;
    const style = getComputedStyle(node);
    const properties = ['color', 'background-color', 'border-top-color', 'border-bottom-color', 'outline-color', 'fill', 'stroke', 'caret-color', 'accent-color'];
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (property.startsWith('border') && parseFloat(style.getPropertyValue(property.replace('color', 'width'))) === 0) continue;
      if (property === 'outline-color' && (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0)) continue;
      if ((property === 'fill' || property === 'stroke') && !(node instanceof SVGElement)) continue;
      if (cyanish(value)) cyan.push({element: name(node), property, color: value});
    }
    for (const match of `${style.backgroundImage} ${style.boxShadow}`.matchAll(/(?:rgba?|oklch|oklab|color)\([^)]*\)|#[0-9a-f]{3,8}\b/gi))
      if (cyanish(match[0])) cyan.push({element: name(node), property: 'background-image/box-shadow', color: match[0]});
  }
  return {borderedControls, cyan};
}
