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
  function over(front: number[], back: number[]) {
    const alpha=front[3]+back[3]*(1-front[3]);
    return [...front.slice(0,3).map((channel,index)=>alpha ? (channel*front[3]+back[index]*back[3]*(1-front[3]))/alpha : 0),alpha];
  }
  return Array.from(element.querySelectorAll('h2, p, label, input:not([type=checkbox]), select, button')).filter(child => child.checkVisibility() && getComputedStyle(child).opacity === '1').map(child => {
    let background = [0,0,0,0],foreground=rgba(getComputedStyle(child).color);
    // Each ancestor paints behind its child, then applies opacity to that group.
    for (let node: Element | null = child; node; node = node.parentElement) {
      const style=getComputedStyle(node),paint=rgba(style.backgroundColor),opacity=Number(style.opacity);
      background=over(background,paint);foreground=over(foreground,paint);
      background[3]*=opacity;foreground[3]*=opacity;
    }
    const canvas=[1,1,1,1];
    const bg = luminance(over(background,canvas).slice(0,3));
    const fg = luminance(over(foreground,canvas).slice(0,3));
    return {text: child.textContent?.slice(0, 80), tag: child.tagName, ratio: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05)};
  });
}
