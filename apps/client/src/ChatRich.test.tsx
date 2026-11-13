// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ChatRich} from './ChatRich';
import {maxHtmlLength} from './chatHtml';

const open=vi.fn();
beforeEach(()=>{open.mockReset();vi.stubGlobal('open',open);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const show=(text:string)=>render(<ChatRich text={text}/>).container;
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Why the Agent view showed HTML as text: react-markdown turns raw HTML into text unless a rehype plugin parses it. */
it('renders the HTML an agent writes or a person pastes instead of showing its tags as text',()=>{
  const view=show('Intro **bold** and <b>html bold</b>.\n\n<table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td colspan="2">Total</td></tr></tbody></table>\n\n<details open><summary>More</summary>Hidden <kbd>Ctrl</kbd>+<kbd>C</kbd> H<sub>2</sub>O x<sup>2</sup></details>\n\n<h2>Heading</h2><hr><blockquote>quoted</blockquote><ul><li>one</li></ul>');
  expect(view.textContent).not.toContain('<b>');
  expect(view.querySelector('strong')?.textContent).toBe('bold');
  expect(view.querySelector('b')?.textContent).toBe('html bold');
  expect(screen.getByRole('columnheader',{name:'Name'})).toBeTruthy();
  expect(view.querySelector('td')?.getAttribute('colspan')).toBe('2');
  expect(view.querySelector('details')?.open).toBe(true);
  expect(view.querySelector('summary')?.textContent).toBe('More');
  expect([...view.querySelectorAll('kbd')].map(key=>key.textContent)).toEqual(['Ctrl','C']);
  expect(view.querySelector('sub')?.textContent).toBe('2');
  expect(view.querySelector('sup')?.textContent).toBe('2');
  for(const selector of ['h2','hr','blockquote','ul > li'])expect(view.querySelector(selector),selector).not.toBeNull();
});

it('puts every table in a keyboard-focusable scroll region so a wide table cannot widen the message',()=>{
  const view=show('<table><tr><td>a</td></tr></table>');
  const region=screen.getByRole('region',{name:'Table'});
  expect(region.tabIndex).toBe(0);
  expect(region.firstElementChild).toBe(view.querySelector('table'));
});

it('keeps HTML inside code fences and inline code literal',()=>{
  const view=show('```html\n<div onclick="x()"><b>no</b></div>\n```\n\nInline `<script>alert(1)</script>` stays.');
  expect(view.querySelector('code.language-html')?.textContent).toBe('<div onclick="x()"><b>no</b></div>\n');
  expect(view.querySelector('div,b,script')).toBeNull();
  expect(view.textContent).toContain('<script>alert(1)</script>');
  expect(screen.queryByRole('button',{name:'Show source'})).toBeNull();
});

it('shows a tag that is not on the list as typed, so prose such as Vec<String> and harness tags are not lost',()=>{
  const view=show('Return `Vec<T>` or Vec<String> to <file> callers.\n\n<system-reminder>keep me</system-reminder>\n\n<script>1</script><style>x</style>');
  expect(view.textContent).toContain('Return Vec<T> or Vec<String> to <file> callers.');
  expect(view.textContent).toContain('<system-reminder>keep me</system-reminder>');
  expect(view.textContent).toContain('<script>1</script><style>x</style>');
  expect(view.querySelector('script,style,file,system-reminder')).toBeNull();
});

it('toggles between the rendered message and its original text',()=>{
  const text='<b>hi</b> there';
  const view=show(text);
  const toggle=screen.getByRole('button',{name:'Show source'});
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  expect(view.querySelector('pre.chat-html-source')?.textContent).toBe(text);
  expect(view.querySelector('b')).toBeNull();
  expect(screen.getByRole('button',{name:'Show rendered'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'Show rendered'}));
  expect(view.querySelector('b')?.textContent).toBe('hi');
});

it('offers no source toggle for plain Markdown and does not render HTML past the size cap',()=>{
  show('Just **markdown** with a [link](https://example.com).');
  expect(screen.queryByRole('button',{name:'Show source'})).toBeNull();
  cleanup();
  const huge=`<b>big</b>${'x'.repeat(maxHtmlLength)}`;
  const view=show(huge);
  expect(view.querySelector('b')).toBeNull();
  expect(view.textContent).toContain('<b>big</b>');
});

it('opens a link only after the person confirms, in a new context without opener',()=>{
  show('Read <a href="https://example.com/docs" onclick="steal()">the docs</a> and [more](https://example.org/x).');
  const link=screen.getByRole('link',{name:'the docs'});
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(link.hasAttribute('onclick')).toBe(false);
  expect(link.hasAttribute('target')).toBe(false);
  expect(fireEvent.click(link)).toBe(false);
  expect(open).not.toHaveBeenCalled();
  const consent=screen.getByRole('region',{name:'Open this address?'});
  expect(consent.textContent).toContain('https://example.com/docs');
  fireEvent.click(screen.getByRole('button',{name:'Dismiss link'}));
  expect(screen.queryByRole('region',{name:'Open this address?'})).toBeNull();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link',{name:'more'}));
  fireEvent.click(screen.getByRole('button',{name:'Open in browser'}));
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.org/x','_blank','noopener,noreferrer');
});

it('never requests a remote image: it shows a blocked image and opens its address only on request',()=>{
  const view=show('<img src="https://tracker.example/p.png?u=1" alt="chart"> ![md](https://tracker.example/m.png)');
  expect(view.querySelector('img')).toBeNull();
  expect(screen.getAllByText('[Image — view in terminal]')).toHaveLength(2);
  expect(screen.getByText('chart').tagName).toBe('Q');
  fireEvent.click(screen.getAllByRole('button',{name:'Open image in browser'})[0]);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Open in browser'}));
  expect(open).toHaveBeenCalledExactlyOnceWith('https://tracker.example/p.png?u=1','_blank','noopener,noreferrer');
});

it('shows a small embedded raster image and blocks other data images',()=>{
  const view=show(`<img src="${pixel}" alt="dot" onerror="x()">\n\n<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="vector">\n\n<img src="data:image/png;base64,${'A'.repeat(300_000)}" alt="huge">`);
  const images=[...view.querySelectorAll('img')];
  expect(images.map(image=>image.getAttribute('src'))).toEqual([pixel]);
  expect(images[0].hasAttribute('onerror')).toBe(false);
  expect(images[0].getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(screen.getAllByText('[Image — view in terminal]')).toHaveLength(2);
});

const corpus:Record<string,string>={
  script:'<script>window.__xss=1</script>after',
  'img onerror':'<img src=x onerror="window.__xss=1">',
  'unterminated img':'<img src="x" onerror=window.__xss=1//',
  'javascript link':'<a href="javascript:window.__xss=1">x</a>',
  'mixed case javascript link':'<a href="  JaVaScRiPt:window.__xss=1">x</a>',
  'tab in javascript link':'<a href="jav&#x09;ascript:window.__xss=1">x</a>',
  'entity javascript link':'<a href="&#106;avascript&colon;window.__xss=1">x</a>',
  'markdown javascript link':'[x](javascript:window.__xss=1)',
  'markdown javascript reference':'[x][r]\n\n[r]: javascript:window.__xss=1',
  'data html link':'<a href="data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==">x</a>',
  'vbscript link':'<a href="vbscript:msgbox(1)">x</a>',
  'file link':'<a href="file:///etc/passwd">x</a>',
  'credentials link':'<a href="https://user:secret@evil.example/">x</a>',
  svg:'<svg onload="window.__xss=1"><script>window.__xss=1</script><a xlink:href="javascript:1"><text>x</text></a></svg>',
  math:'<math><mi xlink:href="javascript:window.__xss=1">x</mi></math>',
  iframe:'<iframe src="https://evil.example" srcdoc="<script>window.__xss=1</script>"></iframe>',
  object:'<object data="javascript:window.__xss=1"></object><embed src="https://evil.example/x.swf">',
  style:'<style>body{display:none}</style>x',
  'style attribute':'<div style="position:fixed;inset:0;z-index:99999" class="overlay" id="root">cover</div>',
  meta:'<meta http-equiv="refresh" content="0;url=https://evil.example">',
  link:'<link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/">',
  form:'<form action="https://evil.example" method="post"><input name="password"><button formaction="https://evil.example">go</button><textarea>t</textarea><select><option>1</option></select></form>',
  'split tag':'<scr<script>ipt>window.__xss=1</scr</script>ipt>',
  'attribute carries tag':'<img src="<script>" onerror="window.__xss=1">',
  'comment':'<!--><script>window.__xss=1</script>-->',
  'conditional comment':'<!--[if IE]><script>window.__xss=1</script><![endif]-->',
  'handler on allowed tag':'<a href="https://ok.example/" onmouseover="window.__xss=1" target="_blank" ping="https://evil.example">ok</a>',
  'details toggle':'<details open ontoggle="window.__xss=1"><summary>s</summary>b</details>',
  'table background':'<table background="javascript:window.__xss=1"><tr><td background="x" style="x">c</td></tr></table>',
  'clobbering':'<p id="__proto__" name="body" class="x" data-x="1" aria-hidden="true" srcset="https://evil.example/x 1x">p</p>',
  'img srcset':'<img src="x" srcset="https://evil.example/pixel.gif 1x" alt="a">',
  'uppercase and nulls':'<IMG SRC=x ONERROR=window.__xss=1><A HREF="java\u0000script:1">x</A>',
  'deep nesting':'<div>'.repeat(300)+'deep'+'</div>'.repeat(300),
  'many elements':'<b>x</b>'.repeat(6000),
};
const allowed=new Set('html body h1 h2 h3 h4 h5 h6 p br hr div span blockquote pre code ul ol li dl dt dd em strong b i u s del ins mark small sub sup kbd samp abbr cite q details summary figure figcaption table caption thead tbody tfoot tr th td a img button'.split(' '));
const attributes=new Set(['href','title','alt','src','colspan','rowspan','start','open','class','rel','type','tabindex','role','aria-label','aria-pressed','loading','referrerpolicy','disabled']);

it.each(Object.entries(corpus))('keeps %s inert and inside the allow-list',(_name,payload)=>{
  (window as unknown as {__xss?:number}).__xss=undefined;
  const view=show(payload);
  for(const element of view.querySelectorAll('*')) {
    const tag=element.tagName.toLowerCase();
    expect(allowed.has(tag),`<${tag}>`).toBe(true);
    for(const attribute of element.attributes) {
      expect(attributes.has(attribute.name),`${tag}[${attribute.name}]`).toBe(true);
      expect(`${attribute.name}=${attribute.value}`).not.toMatch(/^(class|id|style)=(?!(language-[\w+#.-]+|chat-[\w-]+)$)./);
    }
    if(element.hasAttribute('href'))expect(element.getAttribute('href')).toMatch(/^https?:\/\/[^@\s]+$/);
    if(element.hasAttribute('src'))expect(element.getAttribute('src')).toMatch(/^data:image\/(png|jpeg|gif|webp);base64,/);
  }
  expect(view.querySelector('[id],[style],[srcset],[target],[ping],[background],[formaction]')).toBeNull();
  expect((window as unknown as {__xss?:number}).__xss).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

it('keeps the text around a stripped payload and the safe parts of a mixed one',()=>{
  const view=show('<a href="https://ok.example/" onmouseover="x()">ok</a> then <img src=x onerror="x()"> end');
  expect(screen.getByRole('link',{name:'ok'}).getAttribute('href')).toBe('https://ok.example/');
  expect(view.textContent).toContain('then');
  expect(view.textContent).toContain('end');
  expect(view.querySelector('img')).toBeNull();
});

it('limits nesting and element count without crashing or losing the text',()=>{
  const view=show(corpus['deep nesting']);
  expect(view.textContent).toContain('deep');
  expect(view.querySelectorAll('div').length).toBeLessThan(50);
  cleanup();
  const many=show(corpus['many elements']);
  expect(many.querySelectorAll('b').length).toBeLessThanOrEqual(4000);
  expect(many.textContent?.replace('Show source','')).toBe('x'.repeat(6000));
});
