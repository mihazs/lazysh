import {lstat,open,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {insideStandardRoot,standardDiagnosticIdentity} from './windows-standard-progress';

export const standardObservationName='standard-observation.jsonl';
export const standardObservationHelper='standard-observation.cs';
// Separate from the frozen owner compilation. No account, launch, token-write,
// suspension, termination or GUI operation is available to this type.
export const standardObservationSource=String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class StandardChildObservation {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {public uint Size,Usage,Id;public UIntPtr Heap;public uint Module,Threads,Parent;public int Priority;public uint Flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string Name;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="Process32FirstW",SetLastError=true)] static extern bool First(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="Process32NextW",SetLastError=true)] static extern bool Next(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",EntryPoint="OpenProcess")] static extern IntPtr QueryProcess(uint access,bool inherit,uint id);
  [DllImport("kernel32.dll",EntryPoint="GetProcessTimes")] static extern bool Times(IntPtr process,out long birth,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",EntryPoint="QueryFullProcessImageNameW",CharSet=CharSet.Unicode)] static extern bool Image(IntPtr process,uint flags,System.Text.StringBuilder path,ref uint length);
  [DllImport("kernel32.dll",EntryPoint="CloseHandle")] static extern bool Close(IntPtr handle);
  [DllImport("kernel32.dll",EntryPoint="GetProcessId")] static extern uint Id(IntPtr handle);
  [DllImport("kernel32.dll",EntryPoint="WaitForSingleObject")] static extern uint Wait(IntPtr handle,uint timeout);
  [DllImport("advapi32.dll",EntryPoint="OpenProcessToken",SetLastError=true)] static extern bool QueryToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",EntryPoint="GetTokenInformation")] static extern bool TokenSession(IntPtr token,int kind,out uint session,uint length,out uint needed);
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct FileIdentity {public uint Attributes;public long Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
  [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)] static extern Microsoft.Win32.SafeHandles.SafeFileHandle OpenRecord(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandle")] static extern bool RecordIdentity(Microsoft.Win32.SafeHandles.SafeFileHandle handle,out FileIdentity identity);
  readonly string root,image,hash;readonly uint parent;readonly long parentBirth,deadline;readonly Thread worker;readonly FileStream output;readonly ManualResetEvent stop=new ManualResetEvent(false);
  long previous=-1,selectedBirth;uint selectedId;int sequence;
  public StandardChildObservation(string root,string image,string hash,long deadline){
    if(!Layout())throw new InvalidOperationException();
    this.root=root;this.image=image;this.hash=hash;this.deadline=deadline;
    using(var process=Process.GetCurrentProcess()){parent=(uint)process.Id;parentBirth=process.StartTime.ToUniversalTime().ToFileTimeUtc();}
    using(var algorithm=System.Security.Cryptography.SHA256.Create())using(var file=File.OpenRead(image)){if(Convert.ToHexString(algorithm.ComputeHash(file)).ToLowerInvariant()!=hash)throw new InvalidOperationException();}
    string destination=Path.Combine(root,"standard-observation.jsonl");if((File.GetAttributes(destination)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException();
    var record=OpenRecord(destination,0xc0000000,7,IntPtr.Zero,3,0x200000,IntPtr.Zero);FileIdentity facts;
    if(record.IsInvalid||!RecordIdentity(record,out facts)||(facts.Attributes&0x410)!=0||facts.Links!=1){record.Dispose();throw new InvalidOperationException();}
    try{output=new FileStream(record,FileAccess.Write);}catch{record.Dispose();throw;}
    try{if(output.Length<=0||output.Length>512)throw new InvalidOperationException();output.Seek(0,SeekOrigin.End);worker=new Thread(Run);worker.IsBackground=true;worker.Start();}catch{output.Dispose();throw;}
  }
  public void Stop(){stop.Set();if(worker.Join(50))stop.Dispose();}
  public static bool Identity(bool complete,uint id,uint actualParent,uint expectedParent,long birth,long minimum,long maximum,string path,string expectedPath,string sid,string expectedSid,int session,int expectedSession){
    return complete&&id>0&&expectedParent>0&&actualParent==expectedParent&&minimum>0&&birth>=minimum&&birth<=maximum&&!String.IsNullOrEmpty(path)&&!String.IsNullOrEmpty(sid)&&expectedSession>0&&String.Equals(path,expectedPath,StringComparison.OrdinalIgnoreCase)&&sid==expectedSid&&session==expectedSession;
  }
  public static bool Pinned(uint id,long birth,uint selected,long previousBirth){return selected==0||(id==selected&&birth==previousBirth);}
  public static bool Layout(){return IntPtr.Size==8&&Marshal.SizeOf(typeof(Entry))==568&&Marshal.SizeOf(typeof(FileIdentity))==52;}
  static bool ParentOf(uint child,uint parent,out uint threads){
    threads=0;IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))return false;
    try{var entry=new Entry{Size=(uint)Marshal.SizeOf(typeof(Entry))};int count=0;if(!First(snapshot,ref entry))return false;do{if(++count>4096)return false;if(entry.Id==child&&entry.Parent==parent){threads=entry.Threads;return threads<=4096;}}while(Next(snapshot,ref entry));return false;}finally{Close(snapshot);}
  }
  uint Candidate(){
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))return 0;
    try{var entry=new Entry{Size=(uint)Marshal.SizeOf(typeof(Entry))};uint candidate=0;int count=0;if(!First(snapshot,ref entry))return 0;do{if(++count>4096)return 0;if(entry.Parent==parent&&String.Equals(entry.Name,Path.GetFileName(image),StringComparison.OrdinalIgnoreCase)){if(candidate!=0)return 0;candidate=entry.Id;}}while(Next(snapshot,ref entry));int error=Marshal.GetLastWin32Error();return error==18?candidate:0;}finally{Close(snapshot);}
  }
  static bool CurrentBirth(uint id,long expected){
    IntPtr current=QueryProcess(0x1000,false,id);if(current==IntPtr.Zero)return false;
    try{long birth,exit,kernel,user;return Id(current)==id&&Times(current,out birth,out exit,out kernel,out user)&&birth==expected;}finally{Close(current);}
  }
  static bool BoundParent(uint id,uint parent,long birth,out uint threads){threads=0;return CurrentBirth(id,birth)&&ParentOf(id,parent,out threads)&&CurrentBirth(id,birth);}
  string Sample(){
    IntPtr process=IntPtr.Zero,token=IntPtr.Zero;long before,exit,kernel,user,after,kernelAfter,userAfter;uint threads;
    try{
      using(var owner=Process.GetCurrentProcess()){if((uint)owner.Id!=parent||owner.StartTime.ToUniversalTime().ToFileTimeUtc()!=parentBirth)return Unknown();}
      var account=File.ReadAllLines(Path.Combine(root,"account.owner"));long intent;
      if(account.Length!=8||account[4]!="INTENT"||account[5]!=hash||!long.TryParse(account[6],out intent)||intent<=0||!System.Text.RegularExpressions.Regex.IsMatch(account[1],@"\AS-1-5-21-(?:[0-9]+-){3}[0-9]+\z"))return Unknown();
      uint candidate=Candidate();if(candidate==0||!ParentOf(candidate,parent,out threads))return Unknown();
      // PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, never ALL_ACCESS.
      process=QueryProcess(0x101000,false,candidate);if(process==IntPtr.Zero||Id(process)!=candidate||!Times(process,out before,out exit,out kernel,out user))return Unknown();
      var path=new System.Text.StringBuilder(32768);uint length=32768;if(!Image(process,0,path,ref length)||!QueryToken(process,8,out token))return Unknown();
      string sid;using(var identity=new System.Security.Principal.WindowsIdentity(token)){sid=identity.User.Value;}uint session,needed;if(!TokenSession(token,12,out session,4,out needed)||needed!=4||session>Int32.MaxValue)return Unknown();if(!Close(token))return Unknown();token=IntPtr.Zero;
      int expectedSession;using(var owner=Process.GetCurrentProcess()){expectedSession=owner.SessionId;}
      bool complete=BoundParent(candidate,parent,before,out threads)&&Times(process,out after,out exit,out kernelAfter,out userAfter)&&before==after&&kernelAfter>=kernel&&userAfter>=user;
      if(!Identity(complete,candidate,parent,parent,before,Math.Max(parentBirth,new DateTime(intent,DateTimeKind.Utc).ToFileTimeUtc()),DateTime.UtcNow.ToFileTimeUtc(),path.ToString(),image,sid,account[1],(int)session,expectedSession)||!Pinned(candidate,before,selectedId,selectedBirth))return Unknown();
      if(!BoundParent(candidate,parent,before,out threads)||!Times(process,out after,out exit,out kernelAfter,out userAfter)||before!=after)return Unknown();
      uint state=Wait(process,0);if(state!=0&&state!=258)return Unknown();long cpu=checked(kernelAfter+userAfter);if(cpu<0)return Unknown();
      string activity=previous<0?"UNVERIFIED":cpu>previous?"ADVANCED":cpu==previous?"UNCHANGED":"UNVERIFIED";previous=cpu;selectedId=candidate;selectedBirth=before;
      return "{\"identity\":\"VERIFIED\",\"state\":\""+(state==0?"EXITED":"LIVE")+"\",\"cpu\":\""+activity+"\",\"threads\":"+threads+"}";
    }catch{previous=-1;return Unknown();}finally{if(token!=IntPtr.Zero)Close(token);if(process!=IntPtr.Zero)Close(process);}
  }
  static string Unknown(){return "{\"identity\":\"UNVERIFIED\",\"state\":\"UNVERIFIED\",\"cpu\":\"UNVERIFIED\",\"threads\":0}";}
  void Run(){
    try{long started=Environment.TickCount64;foreach(int target in new[]{30000,120000,300000}){
      long remaining=started+target-Environment.TickCount64;if(remaining<0||started+target>=deadline-15000||remaining>300000||stop.WaitOne((int)remaining))return;
      string sample=Sample();if(stop.WaitOne(0))return;
      if(output.Length>1536)return;var bytes=System.Text.Encoding.UTF8.GetBytes("{\"sequence\":"+(++sequence)+",\"sample\":"+sample+"}\n");output.Write(bytes,0,bytes.Length);output.Flush();
    }}catch{}finally{output.Dispose();}
  }
}
`;
export const standardObservationHash=createHash('sha256').update(standardObservationSource).digest('hex');
export function standardObservationHeader(root:string,source:string,binary:string){
  const identity=standardDiagnosticIdentity(root.split(/[\\/]/).at(-1),source,binary);
  if(!identity)throw new Error('Standard observation identity unavailable');
  return JSON.stringify(identity)+'\n';
}
export async function stageStandardObservation(root:string,source:string,binary:string){
  try{
    const header=standardObservationHeader(root,source,binary);
    const entry=await lstat(root),actual=await realpath(root);
    if(root!==resolve(root)||!entry.isDirectory()||entry.isSymbolicLink()||!insideStandardRoot(actual,root)||!insideStandardRoot(root,actual))return false;
    await writeFile(join(root,standardObservationHelper),standardObservationSource,{flag:'wx'});
    await writeFile(join(root,standardObservationName),header,{flag:'wx'});
    return true;
  }catch{return false;}
}

export function standardObservationBroker(script:string,mode:'gui'|'bootstrap-exit'|'node-bootstrap-exit'){
  const image=mode==='node-bootstrap-exit'?'node.exe':'bun.exe';
  return String.raw`$standardObserver=$null;try{try{$helper=Join-Path $env:LAZYSH_WINDOWS_STANDARD_ROOT '${standardObservationHelper}';$item=Get-Item -LiteralPath $helper -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne ${Buffer.byteLength(standardObservationSource)}){throw 'observer'};$text=[IO.File]::ReadAllText($helper);$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant();if($hash -cne '${standardObservationHash}'){throw 'observer'};Add-Type -TypeDefinition $text -ErrorAction Stop;$standardObserver=[StandardChildObservation]::new($env:LAZYSH_WINDOWS_STANDARD_ROOT,(Join-Path $env:LAZYSH_WINDOWS_STANDARD_ROOT 'bin/${image}'),$env:LAZYSH_STANDARD_IMAGE_HASH,([Environment]::TickCount64+[long]$env:LAZYSH_STANDARD_REMAINING))}catch{};& {${script}}}finally{if($standardObserver){try{$standardObserver.Stop()}catch{}}}`;
}

export function standardObservationProjection(value:unknown){
  const rejected={kind:'NON_ACCEPTANCE_STANDARD_CHILD_OBSERVATION',status:'UNVERIFIED',samples:[] as unknown[]};
  if(!Array.isArray(value)||value.length>3)return rejected;
  const samples=[];
  for(const [index,item] of value.entries()){
    if(!item||typeof item!=='object'||Object.keys(item).sort().join(',')!=='sample,sequence'||item.sequence!==index+1)return rejected;
    const row=item.sample;
    if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='cpu,identity,state,threads'||!['VERIFIED','UNVERIFIED'].includes(row.identity)||!['LIVE','EXITED','UNVERIFIED'].includes(row.state)||!['ADVANCED','UNCHANGED','UNVERIFIED'].includes(row.cpu)||!Number.isInteger(row.threads)||row.threads<0||row.threads>4096)return rejected;
    if(row.identity==='UNVERIFIED'&&(row.state!=='UNVERIFIED'||row.cpu!=='UNVERIFIED'||row.threads!==0))return rejected;
    if(row.identity==='VERIFIED'&&row.state==='UNVERIFIED')return rejected;
    samples.push({sequence:item.sequence,sample:{identity:row.identity,state:row.state,cpu:row.cpu,threads:row.threads}});
  }
  return {...rejected,status:samples.length===3&&samples.every(item=>item.sample.identity==='VERIFIED')?'OBSERVED':'UNVERIFIED',samples};
}
export async function readStandardObservation(root:string,source:string,binary:string){
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    if(!standardDiagnosticIdentity(root.split(/[\\/]/).at(-1),source,binary))throw new Error();
    const path=join(root,standardObservationName),before=await lstat(path);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>2048||!insideStandardRoot(await realpath(path),root))throw new Error();
    file=await open(path,'r');const held=await file.stat();if(held.dev!==before.dev||held.ino!==before.ino)throw new Error();
    const bytes=Buffer.alloc(2049),read=await file.read(bytes,0,bytes.length,0),after=await file.stat(),leaf=await lstat(path);
    if(read.bytesRead>2048||after.size!==read.bytesRead||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.ino!==before.ino||after.dev!==before.dev||after.nlink!==1||leaf.ino!==after.ino||leaf.dev!==after.dev||leaf.size!==after.size||leaf.mtimeMs!==after.mtimeMs||leaf.ctimeMs!==after.ctimeMs||leaf.isSymbolicLink()||leaf.nlink!==1)throw new Error();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,read.bytesRead));
    const lines=text.trim().split(/\r?\n/),header=JSON.parse(lines.shift()!);
    if(!header||Object.keys(header).sort().join(',')!=='binary,fixture,source'||JSON.stringify(header)!==standardObservationHeader(root,source,binary).trim())throw new Error();
    return standardObservationProjection(lines.map(line=>JSON.parse(line)));
  }catch{return standardObservationProjection(undefined);}finally{await file?.close().catch(()=>{});}
}
