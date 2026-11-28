/** What a person can add when starting an agent: their own arguments, and the agent's flag that turns its approval prompts off. */
export type LaunchOptions={yolo:boolean;text:string};
export const noOptions:LaunchOptions={yolo:false,text:''};

/** The flag that turns off an agent's approval prompts, only for agents whose installed CLI lists it in `--help` (Claude Code 2.1.326,
 * codex-cli 0.172.0, which has no `--yolo` alias, and OpenCode 2.3.2, which older 1.x releases do not have). An agent without a
 * verified flag gets no preset. */
export const yoloFlags:Readonly<Record<string,string>>={
  claude:'--dangerously-skip-permissions',
  codex:'--dangerously-bypass-approvals-and-sandbox',
  opencode:'--auto',
};
export const argumentLimits={count:32,bytes:512} as const;

export type ArgumentProblem='quote'|'limit'|'plain';
const control=/[\x00-\x1f\x7f-\x9f]/u;
const size=(value:string)=>new TextEncoder().encode(value).length;

/** Splits like a POSIX shell without expanding anything: spaces separate words, single or double quotes group them, a backslash
 * escapes the next character. The words are what the agent receives; no `$`, `;`, `&&` or glob in them ever means anything. */
export function splitArguments(text:string):{args:string[]}|{problem:ArgumentProblem} {
  if(control.test(text))return {problem:'limit'};
  const args:string[]=[];
  let word='',started=false,quote='';
  for(let index=0;index<text.length;index++) {
    const char=text[index];
    if(quote) {
      if(char===quote)quote='';
      else if(char==='\\' && quote==='"' && (text[index+1]==='"' || text[index+1]==='\\'))word+=text[++index];
      else word+=char;
    } else if(char==='"' || char==="'") {quote=char;started=true;}
    else if(char==='\\') {
      if(index+1===text.length)return {problem:'quote'};
      word+=text[++index];started=true;
    } else if(char===' ') {
      if(started)args.push(word);
      word='';started=false;
    } else {word+=char;started=true;}
  }
  if(quote)return {problem:'quote'};
  if(started)args.push(word);
  return args.length>argumentLimits.count || args.some(arg=>size(arg)>argumentLimits.bytes) ? {problem:'limit'} : {args};
}

/** One shell word: left bare only when it holds nothing a shell reads, otherwise single-quoted. */
const word=(value:string)=>/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'","'\\''")}'`;

/** The words after an agent's executable: its YOLO flag when chosen and offered, then the person's arguments. */
export const agentArgv=(agent:string,yolo:boolean,args:readonly string[]):string[]=>[...(yolo && yoloFlags[agent] ? [yoloFlags[agent]] : []),...args];

/** The agent's command line, every word quoted, so the line is what runs and what is shown. */
export const agentCommand=(agent:string,yolo:boolean,args:readonly string[])=>[agent,...agentArgv(agent,yolo,args)].map(word).join(' ');

/** The argv words a launcher sends. Its native checks also refuse an empty or blank word and a backslash (tmux reads a trailing
 * `;` again), and count the YOLO flag among the 32 words. */
export function launchArguments(agent:string,{yolo,text}:LaunchOptions):{args:string[]}|{problem:ArgumentProblem} {
  const split=splitArguments(text);
  if('problem' in split)return split;
  if(split.args.some(arg=>!arg.trim() || arg.includes('\\')))return {problem:'plain'};
  const args=agentArgv(agent,yolo,split.args);
  return args.length>argumentLimits.count ? {problem:'limit'} : {args};
}
