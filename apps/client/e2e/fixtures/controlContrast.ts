export function controlContrast(element: Element) {
  const context = document.createElement('canvas').getContext('2d')!;
  function rgba(color: string) {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data).map(n => n / 255);
  }
  function luminance(rgb: number[]) {
    const [r, g, b] = rgb.map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * b;
  }
  return Array.from(element.querySelectorAll('h2, p, label, input:not([type=checkbox]), select, button')).filter(child => child.checkVisibility() && getComputedStyle(child).opacity === '1').map(child => {
    let background = [1, 1, 1];
    const ancestors: Element[] = [];
    for (let node: Element | null = child; node; node = node.parentElement) ancestors.unshift(node);
    for (const node of ancestors) {
      const [r, g, b, alpha] = rgba(getComputedStyle(node).backgroundColor);
      background = [r, g, b].map((c, i) => c * alpha + background[i] * (1 - alpha));
    }
    const bg = luminance(background);
    const fg = luminance(rgba(getComputedStyle(child).color).slice(0, 3));
    return {text: child.textContent?.slice(0, 80), tag: child.tagName, ratio: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05)};
  });
}
