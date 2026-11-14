// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {findPaths,findUrls,type Rows} from './terminalLinks';

const wide=(char:string)=>/[⺀-鿿＀-￯]/.test(char);
/** A synthetic screen: `lines` hold what each row displays, `wrapped` the rows xterm marked as soft-wrapped. */
function screen(lines:string[],cols:number,wrapped:number[]=[]):Rows {
  const cells=lines.map(line=>{
    const row:{chars:string;width:number}[]=[];
    for(const char of line)row.push({chars:char,width:wide(char)?2:1},...(wide(char)?[{chars:'',width:0}]:[]));
    while(row.length<cols)row.push({chars:'',width:1});
    return row;
  });
  return {length:lines.length,getLine:y=>y<0||y>=lines.length?undefined:{isWrapped:wrapped.includes(y),getCell:x=>{const cell=cells[y][x];return cell&&{getChars:()=>cell.chars,getWidth:()=>cell.width};}}};
}
/** Splits `text` over rows of `cols` cells the way a terminal soft-wraps it. */
function softWrap(text:string,cols:number,prefix:string[]=[]) {
  const rows=[...prefix];const wrapped:number[]=[];
  for(let i=0;i<text.length;i+=cols){if(i>0)wrapped.push(rows.length);rows.push(text.slice(i,i+cols));}
  return {rows,wrapped};
}
const urls=(rows:Rows,cols:number,line:number)=>findUrls(rows,cols,line).map(link=>link.text);
const long='https://example.com/docs/guides/getting-started/installation?ref=terminal&lang=en#section-two';

describe('soft-wrapped URLs',()=>{
  it('joins the rows of one wrapped line and answers on every row of it',()=>{
    const {rows,wrapped}=softWrap(`open ${long} now`,30,['$ run']);
    const screenRows=screen(rows,30,wrapped);
    for(let line=2;line<=rows.length;line++)expect(urls(screenRows,30,line)).toEqual([long]);
    expect(urls(screenRows,30,1)).toEqual([]);
    const [link]=findUrls(screenRows,30,2);
    expect(link.range).toEqual({start:{x:6,y:2},end:{x:(`open ${long}`.length-1)%30+1,y:Math.floor((`open ${long}`.length-1)/30)+2}});
  });
  it('maps wide characters before the URL to their cells',()=>{
    const [link]=findUrls(screen(['世界 https://example.com/日本'],40),40,1);
    expect(link.text).toBe('https://example.com/日本');
    expect(link.range.start).toEqual({x:6,y:1});
    expect(link.range.end).toEqual({x:6+'https://example.com/'.length+4-1,y:1});
  });
});

describe('hard-wrapped URLs in text interfaces',()=>{
  it('joins a URL broken at the border of a box and drops the border and padding',()=>{
    const rows=screen([
      '┌────────────────────────┐',
      '│ see https://example.co │',
      '│ m/a/very/long/path/to/ │',
      '│ page?id=42 for details │',
      '└────────────────────────┘',
    ],26);
    for(const line of [2,3,4])expect(urls(rows,26,line)).toEqual(['https://example.com/a/very/long/path/to/page?id=42']);
    const [link]=findUrls(rows,26,3);
    expect(link.range).toEqual({start:{x:7,y:2},end:{x:12,y:4}});
  });
  it('joins a URL a program broke at the full width of the screen',()=>{
    const rows=screen(['  see https://example.com/some/long/pa','th/with/more/segments?q=1 done'],38);
    expect(urls(rows,38,2)).toEqual(['https://example.com/some/long/path/with/more/segments?q=1']);
  });
  it('joins a program\'s own narrower wrap for a long URL under list indentation',()=>{
    const rows=screen(['  ⎿  See https://example.com/some/long/path/to/the/docs/pa','     ge/index?lang=en&ref=agent'],64);
    expect(urls(rows,64,2)).toEqual(['https://example.com/some/long/path/to/the/docs/page/index?lang=en&ref=agent']);
  });
  it('follows a URL over three hard-wrapped rows',()=>{
    const box=(inner:string)=>`│ ${inner.padEnd(26)} │`;
    const rows=screen([box('https://example.com/aaaaaa'),box('b'.repeat(24)+'/c'),box('dddd/eeee')],30);
    expect(urls(rows,30,3)).toEqual(['https://example.com/aaaaaa'+'b'.repeat(24)+'/cdddd/eeee']);
  });
  it('never merges two URLs on adjacent rows, whatever the width',()=>{
    for(const cols of [34,36,60]){
      const rows=screen(['https://one.example/path/to/a/page','https://two.example/other/page?x=1'],cols);
      expect(urls(rows,cols,1)).toEqual(['https://one.example/path/to/a/page']);
      expect(urls(rows,cols,2)).toEqual(['https://two.example/other/page?x=1']);
    }
    const boxed=screen(['│ https://one.example/aaaaaaaa   │','│ https://two.example/bbbbbbbb   │'],34);
    expect(urls(boxed,34,1)).toEqual(['https://one.example/aaaaaaaa']);
    expect(urls(boxed,34,2)).toEqual(['https://two.example/bbbbbbbb']);
  });
  it('leaves the next line alone when it reads as prose, a bullet or a path-less word',()=>{
    for(const next of ['and then it failed','- another item','1. second step','Content-Type: text/html','plainword']) {
      const rows=screen(['curl https://example.com/path/ok/12',next],35);
      expect(urls(rows,35,1)).toEqual(['https://example.com/path/ok/12']);
      expect(urls(rows,35,2)).toEqual([]);
    }
    const prose=screen(['│ see https://example.com/a/b/c.  │','│ - then do the next step       │'],34);
    expect(urls(prose,34,1)).toEqual(['https://example.com/a/b/c']);
  });
  it('does not join a short URL that ends well before the edge',()=>{
    const rows=screen(['visit https://example.com/a','b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q'],80);
    expect(urls(rows,80,1)).toEqual(['https://example.com/a']);
  });
});

describe('what belongs to the URL',()=>{
  it.each([
    ['see https://example.com/a.','https://example.com/a'],
    ['(see https://example.com/a)','https://example.com/a'],
    ['<https://example.com/a>, ok','https://example.com/a'],
    ['"https://example.com/a?x=1&y=2",','https://example.com/a?x=1&y=2'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)','https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['(https://en.wikipedia.org/wiki/Foo_(bar))','https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['[docs](https://example.com/a)','https://example.com/a'],
    ['wow https://example.com/a!?','https://example.com/a'],
    ['http://localhost:3000/a#top;','http://localhost:3000/a#top'],
    ['xhttps://example.com ftp://example.com/a',''],
  ])('%j',(line,expected)=>{
    const found=urls(screen([line],80),80,1);
    expect(found).toEqual(expected?[expected]:[]);
  });
  it('finds several URLs on one row, each on its own cells',()=>{
    const links=findUrls(screen(['a https://x.example/1 b https://y.example/2 c'],60),60,1);
    expect(links.map(link=>link.text)).toEqual(['https://x.example/1','https://y.example/2']);
    expect(links[1].range.start.x).toBe(25);
  });
});

describe('host file paths',()=>{
  const paths=(lines:string[],line=1,cols=90)=>findPaths(screen(lines,cols),cols,line).map(({text,path,line,column})=>({text,path,line,column}));
  it('finds absolute, home and dot-relative paths with their line and column',()=>{
    expect(paths(['wrote /var/log/app.log, see ~/notes/todo.md:12 and ./src/main.rs:3:9.'])).toEqual([
      {text:'/var/log/app.log',path:'/var/log/app.log'},
      {text:'~/notes/todo.md:12',path:'~/notes/todo.md',line:12},
      {text:'./src/main.rs:3:9',path:'./src/main.rs',line:3,column:9},
    ].map(link=>({line:undefined,column:undefined,...link})));
  });
  it('finds dir/file.ext paths in quotes and compiler output but not prose or URLs',()=>{
    expect(paths(['error[E0308]: src/lib/mod.rs:40:5']).map(link=>link.path)).toEqual(['src/lib/mod.rs']);
    expect(paths(['open "/tmp/a b.txt" or (/etc/hosts)']).map(link=>link.path)).toEqual(['/tmp/a','/etc/hosts']);
    expect(paths(['read and/or write, 1/2 done, https://example.com/a/b.html and http://h/x/y.js'])).toEqual([]);
    expect(paths(['dir /var/ and / and ... and ~/'])).toEqual([]);
  });
  it('maps the range to the cells, wide characters included, and joins soft-wrapped paths',()=>{
    const [link]=findPaths(screen(['世界 /tmp/日本.log:7'],40),40,1);
    expect(link.path).toBe('/tmp/日本.log');
    expect(link.range).toEqual({start:{x:6,y:1},end:{x:6+'/tmp/'.length+4+'.log:7'.length-1,y:1}});
    const {rows,wrapped}=softWrap('build failed in /home/dev/projects/app/src/components/Panel.tsx:88',24);
    const wrappedScreen=screen(rows,24,wrapped);
    for(let line=1;line<=rows.length;line++)expect(findPaths(wrappedScreen,24,line).map(link=>link.path)).toEqual(['/home/dev/projects/app/src/components/Panel.tsx']);
  });
});
