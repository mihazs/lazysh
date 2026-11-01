import {windowsGuiMediumCommonSource,windowsGuiTokenReasons,windowsGuiDaclFailures} from './windows-installed-gui';
import {digestFile} from './release-artifacts';
import {native,windowsInstallerFailure} from './release-platform';
import {copyFile,lstat,mkdir,readdir,realpath,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';


export const standardWritableDirectories=['work','node_modules/.vite','node_modules/.vite-temp','node_modules/.vitest-cache','apps/client/node_modules/.vite','apps/client/node_modules/.vite-temp'] as const;

const standardCodes=['NAME_ACCESS_DENIED','STANDARD_OWNER_PASSED','STANDARD_OWNER_FAILED','STANDARD_OWNER_TIMEOUT','HOSTED_ONLY','ACCOUNT_BUDGET','ACCOUNT_COLLISION','ACCOUNT_CREATE_UNAVAILABLE','ACCOUNT_IDENTITY','PROFILE_IDENTITY','PROFILE_COLLISION','FIXTURE_IDENTITY','FIXTURE_ACCESS','STANDARD_LOGON_UNAVAILABLE','TOKEN_UNAVAILABLE','DESKTOP_UNAVAILABLE','DESKTOP_SESSION_UNAVAILABLE','DESKTOP_ACCESS_UNAVAILABLE','WINSTA_OPEN_UNAVAILABLE','DESKTOP_OPEN_UNAVAILABLE','WINSTA_BORROWED_NAME_UNAVAILABLE','DESKTOP_BORROWED_NAME_UNAVAILABLE','WINSTA_OPENED_NAME_UNAVAILABLE','DESKTOP_OPENED_NAME_UNAVAILABLE','JOB_UNAVAILABLE','IDENTITY_UNVERIFIED','LAUNCH_UNAVAILABLE','CLEANUP_UNVERIFIED',...windowsGuiDaclFailures,...windowsGuiTokenReasons.map(reason=>'TOKEN_UNAVAILABLE_'+reason)] as const;
// Test-only broker. Native account methods are reached only by the explicit hosted owner.
export const windowsStandardUserSource=windowsGuiMediumCommonSource.replace(
  'Need(handle!=IntPtr.Zero&&GetUserObjectInformation(handle,2,text,256,out needed)&&needed<=256,"DESKTOP_UNAVAILABLE");',
  'Need(handle!=IntPtr.Zero,"DESKTOP_UNAVAILABLE");bool ok=GetUserObjectInformation(handle,2,text,256,out needed);int error=Marshal.GetLastWin32Error();Need(ok&&needed<=256,!ok&&error==5?"NAME_ACCESS_DENIED":"DESKTOP_UNAVAILABLE");',
)+String.raw`
public sealed partial class OwnedMediumGui {
  [StructLayout(LayoutKind.Sequential)] struct AccountInfo {public IntPtr Name,Password;public uint Age,Privilege;public IntPtr Home,Comment;public uint Flags;public IntPtr Script;}
  [StructLayout(LayoutKind.Sequential)] struct AccountIdentity {public IntPtr Name,FullName,Comment;public uint Flags;public IntPtr Sid;}
  [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserAdd(string server,uint level,ref AccountInfo info,out uint parameter);
  [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserGetInfo(string server,string name,uint level,out IntPtr buffer);
  [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetUserDel(string server,string name);
  [DllImport("netapi32.dll")] static extern uint NetApiBufferFree(IntPtr buffer);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileSecurity(string path,uint information,IntPtr descriptor);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithLogonW(string user,string domain,IntPtr password,uint logon,string image,System.Text.StringBuilder command,uint flags,IntPtr environment,string directory,ref SI startup,out PI child);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUserW(string name,string domain,IntPtr password,uint kind,uint provider,out IntPtr token);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteProfileW(string sid,string path,string computer);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegOpenKeyEx(IntPtr key,string path,uint options,uint access,out IntPtr opened);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupAccountSid(string server,IntPtr sid,System.Text.StringBuilder name,ref uint nameLength,System.Text.StringBuilder domain,ref uint domainLength,out uint kind);
  [StructLayout(LayoutKind.Sequential)] struct MemberSid {public IntPtr Sid;}
  [DllImport("netapi32.dll",CharSet=CharSet.Unicode)] static extern uint NetLocalGroupAddMembers(string server,string group,uint level,ref MemberSid member,uint count);
  static void OrdinaryMembership(string sid){IntPtr users=IntPtr.Zero,member=IntPtr.Zero;try{Need(StandardSid(sid)&&ConvertStringSidToSid("S-1-5-32-545",out users)&&ConvertStringSidToSid(sid,out member),"ACCOUNT_IDENTITY");var name=new System.Text.StringBuilder(256);var domain=new System.Text.StringBuilder(256);uint names=256,domains=256,kind;Need(LookupAccountSid(null,users,name,ref names,domain,ref domains,out kind)&&kind==4&&names>0&&names<256,"ACCOUNT_IDENTITY");var record=new MemberSid{Sid=member};uint result=NetLocalGroupAddMembers(null,name.ToString(),0,ref record,1);Need(result==0||result==1378,"ACCOUNT_CREATE_UNAVAILABLE");}finally{if(users!=IntPtr.Zero)Need(LocalFree(users)==IntPtr.Zero,"CLEANUP_UNVERIFIED");if(member!=IntPtr.Zero)Need(LocalFree(member)==IntPtr.Zero,"CLEANUP_UNVERIFIED");}}
  static bool WritableFixture(string path,string root){
    if(path==null||root==null||path.IndexOf('\0')>=0||root.IndexOf('\0')>=0||!System.IO.Path.IsPathFullyQualified(path)||!System.IO.Path.IsPathFullyQualified(root))return false;
    string full=System.IO.Path.GetFullPath(path),parent=System.IO.Path.GetFullPath(root);
    // Device paths skip ordinary Windows normalization; never use them to select writable ACLs.
    if(full.StartsWith(@"\\?\",StringComparison.Ordinal)||full.StartsWith(@"\\.\",StringComparison.Ordinal)||parent.StartsWith(@"\\?\",StringComparison.Ordinal)||parent.StartsWith(@"\\.\",StringComparison.Ordinal))return false;
    foreach(string suffix in new[]{${standardWritableDirectories.map(path=>JSON.stringify(path)).join(',')}}){string entry=System.IO.Path.GetFullPath(System.IO.Path.Combine(parent,suffix));if(String.Equals(full,entry,StringComparison.OrdinalIgnoreCase)||full.StartsWith(entry+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))return true;}
    return false;
  }
  static void FixtureTree(string path,string root,string parent,string child,ref int count,int depth){Need(depth<=64&&++count<=50000,"FIXTURE_IDENTITY");PlainOwned(path,root);if(System.IO.Path.GetFileName(path)=="account.owner"||System.IO.Path.GetFileName(path)=="desktop.owner")return;FixtureAcl(path,root,parent,child,WritableFixture(path,root));if(System.IO.Directory.Exists(path))foreach(string entry in System.IO.Directory.EnumerateFileSystemEntries(path))FixtureTree(entry,root,parent,child,ref count,depth+1);}
  static string ClosedStandardFailure(string value){return Array.IndexOf(new[]{${standardCodes.filter(code=>code!=='STANDARD_OWNER_PASSED').map(code=>JSON.stringify(code)).join(',')}},value)>=0?value:"UNVERIFIED";}
  public static string StandardTokenFailure(){return ClosedStandardFailure("TOKEN_UNAVAILABLE_"+TokenFailure);}
  static string StandardDesktopFailure(){return ClosedStandardFailure(daclFailure);}
  static string StandardPrimaryFailure(string code){return ClosedStandardFailure(code=="TOKEN_UNAVAILABLE"?StandardTokenFailure():code);}
  [DllImport("userenv.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetProfilesDirectory(System.Text.StringBuilder path,ref uint length);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegQueryValueEx(IntPtr key,string name,IntPtr reserved,out uint kind,[Out] byte[] data,ref uint length);
  static bool ProfilePath(string name,string path){return path!=null&&path.Length<=260&&System.Text.RegularExpressions.Regex.IsMatch(path,@"\A[A-Za-z]:\\[^\x00\r\n:/]+\z")&&path.EndsWith("\\"+name,StringComparison.OrdinalIgnoreCase)&&Array.IndexOf(path.Split('\\'),"..")<0&&Array.IndexOf(path.Split('\\'),".")<0;}
  static string ExpectedProfile(string name){Need(System.Text.RegularExpressions.Regex.IsMatch(name??"",@"\Alshci[a-f0-9]{12}\z"),"PROFILE_IDENTITY");var text=new System.Text.StringBuilder(32768);uint length=32768;Need(GetProfilesDirectory(text,ref length)&&length>1&&length<32768&&System.IO.Path.IsPathRooted(text.ToString()),"PROFILE_IDENTITY");string root=System.IO.Path.GetFullPath(text.ToString()),path=System.IO.Path.GetFullPath(System.IO.Path.Combine(root,name));PlainOwned(path,root);Need(ProfilePath(name,path),"PROFILE_IDENTITY");return path;}
  static void OwnedProfile(string sid,string name,string expected){Need(StandardSid(sid)&&ProfilePath(name,expected),"PROFILE_IDENTITY");PlainOwned(expected,System.IO.Path.GetDirectoryName(expected));IntPtr key=IntPtr.Zero;try{Need(RegOpenKeyEx(RegistryRoot(0x80000002),@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\"+sid,0,0x20019,out key)==0,"PROFILE_IDENTITY");byte[] bytes=new byte[65536];uint length=65536,kind;Need(RegQueryValueEx(key,"ProfileImagePath",IntPtr.Zero,out kind,bytes,ref length)==0&&(kind==1||kind==2)&&length>=2&&length<=65536&&length%2==0&&bytes[length-1]==0&&bytes[length-2]==0,"PROFILE_IDENTITY");string path=System.Text.Encoding.Unicode.GetString(bytes,0,(int)length-2);Need(path.IndexOf('\0')<0,"PROFILE_IDENTITY");if(kind==2)path=Environment.ExpandEnvironmentVariables(path);Need(String.Equals(System.IO.Path.GetFullPath(path),expected,StringComparison.OrdinalIgnoreCase),"PROFILE_IDENTITY");}finally{if(key!=IntPtr.Zero)Need(RegCloseKey(key)==0,"CLEANUP_UNVERIFIED");}}
  static bool StandardSid(string sid){return sid!=null&&System.Text.RegularExpressions.Regex.IsMatch(sid,@"\AS-1-5-21-(?:[0-9]{1,10}-){2}[0-9]{1,10}-[0-9]{1,10}\z");}
  static void Hosted(){Need(Environment.OSVersion.Platform==PlatformID.Win32NT&&Environment.Is64BitProcess&&Environment.UserInteractive&&Environment.GetEnvironmentVariable("GITHUB_ACTIONS")=="true"&&Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")=="github-hosted"&&Environment.GetEnvironmentVariable("GITHUB_REPOSITORY")=="mihazs/lazysh","HOSTED_ONLY");}
  static void HostedRoot(string root){Hosted();string run=Environment.GetEnvironmentVariable("GITHUB_RUN_ID"),attempt=Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"),sha=Environment.GetEnvironmentVariable("GITHUB_SHA"),temp=Environment.GetEnvironmentVariable("RUNNER_TEMP");Need(System.Text.RegularExpressions.Regex.IsMatch(run??"",@"\A[0-9]{1,20}\z")&&System.Text.RegularExpressions.Regex.IsMatch(attempt??"",@"\A[0-9]{1,20}\z")&&System.Text.RegularExpressions.Regex.IsMatch(sha??"",@"\A[a-f0-9]{40}\z")&&!String.IsNullOrEmpty(temp),"HOSTED_ONLY");Need(String.Equals(System.IO.Path.GetFullPath(root),System.IO.Path.GetFullPath(System.IO.Path.Combine(temp,"lazysh-standard-"+run+"-"+attempt)),StringComparison.OrdinalIgnoreCase),"FIXTURE_IDENTITY");PlainOwned(root,root);Need(System.IO.File.ReadAllText(System.IO.Path.Combine(root,"fixture.owner"))==sha,"FIXTURE_IDENTITY");}
  static string SidText(IntPtr pointer){IntPtr text=IntPtr.Zero;try{Need(ConvertSidToStringSid(pointer,out text)&&text!=IntPtr.Zero,"ACCOUNT_IDENTITY");string value=Marshal.PtrToStringUni(text);Need(StandardSid(value),"ACCOUNT_IDENTITY");return value;}finally{if(text!=IntPtr.Zero)Need(LocalFree(text)==IntPtr.Zero,"CLEANUP_UNVERIFIED");}}
  static string TokenSid(IntPtr token){byte[] sid=User(token);IntPtr data=Marshal.AllocHGlobal(sid.Length);try{Marshal.Copy(sid,0,data,sid.Length);return SidText(data);}finally{Marshal.FreeHGlobal(data);}}
  static string CurrentSid(){IntPtr caller=IntPtr.Zero;try{Need(OpenProcessToken(GetCurrentProcess(),8,out caller),"ACCOUNT_IDENTITY");return TokenSid(caller);}finally{if(caller!=IntPtr.Zero)Need(CloseHandle(caller),"CLEANUP_UNVERIFIED");}}
  static string[] Account(string name){IntPtr buffer=IntPtr.Zero;try{uint result=NetUserGetInfo(null,name,23,out buffer);if(result==2221)return null;Need(result==0&&buffer!=IntPtr.Zero,"ACCOUNT_IDENTITY");var info=Marshal.PtrToStructure<AccountIdentity>(buffer);return new[]{SidText(info.Sid),Marshal.PtrToStringUni(info.Comment)};}finally{if(buffer!=IntPtr.Zero)Need(NetApiBufferFree(buffer)==0,"CLEANUP_UNVERIFIED");}}
  static IntPtr RegistryRoot(uint root){return new IntPtr(unchecked((int)root));}
  static bool KeyExists(uint root,string path){IntPtr key=IntPtr.Zero;int result=RegOpenKeyEx(RegistryRoot(root),path,0,0x20019,out key);try{Need(result==0||result==2,"PROFILE_IDENTITY");return result==0;}finally{if(key!=IntPtr.Zero)Need(RegCloseKey(key)==0,"CLEANUP_UNVERIFIED");}}
  static bool Profile(string sid){Need(StandardSid(sid),"PROFILE_IDENTITY");return KeyExists(0x80000002,@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\"+sid);}
  static bool Hive(string sid){Need(StandardSid(sid),"PROFILE_IDENTITY");return KeyExists(0x80000003,sid);}
  static void PlainOwned(string path,string root){string full=System.IO.Path.GetFullPath(path),parent=System.IO.Path.GetFullPath(root);Need(full==parent||full.StartsWith(parent+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase),"FIXTURE_IDENTITY");for(var entry=new System.IO.DirectoryInfo(System.IO.Path.GetDirectoryName(full));entry!=null;entry=entry.Parent)Need((entry.Attributes&System.IO.FileAttributes.ReparsePoint)==0,"FIXTURE_IDENTITY");if(System.IO.File.Exists(full)||System.IO.Directory.Exists(full))Need((System.IO.File.GetAttributes(full)&System.IO.FileAttributes.ReparsePoint)==0,"FIXTURE_IDENTITY");}
  static void FixtureAcl(string path,string root,string parent,string child,bool writable){PlainOwned(path,root);Need(StandardSid(parent)&&(child==null||StandardSid(child)),"FIXTURE_IDENTITY");string rules="D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;"+parent+")"+(child==null?"":"(A;OICI;"+(writable?"0x1301bf":"0x1200a9")+";;;"+child+")");IntPtr descriptor=IntPtr.Zero;try{uint size;Need(ConvertStringSecurityDescriptorToSecurityDescriptor(rules,1,out descriptor,out size)&&size>0&&size<=65536&&SetFileSecurity(path,0x80000004,descriptor),"FIXTURE_ACCESS");}finally{if(descriptor!=IntPtr.Zero)Need(LocalFree(descriptor)==IntPtr.Zero,"CLEANUP_UNVERIFIED");}}
  static string[] Capsule(string root){string path=System.IO.Path.Combine(root,"account.owner");PlainOwned(path,root);Need(new System.IO.FileInfo(path).Length<=2048,"ACCOUNT_IDENTITY");var parts=System.IO.File.ReadAllLines(path);Need(parts.Length==8&&System.Text.RegularExpressions.Regex.IsMatch(parts[0],@"\Alshci[a-f0-9]{12}\z")&&(parts[1]==""||StandardSid(parts[1]))&&System.Text.RegularExpressions.Regex.IsMatch(parts[2],@"\A[a-f0-9]{32}\z")&&(parts[3]=="0"||parts[3]=="1")&&(parts[4]=="SETUP"||parts[4]=="INTENT"||parts[4]=="RETIRED"||parts[4]=="ACL_RETIRING")&&System.Text.RegularExpressions.Regex.IsMatch(parts[5],@"\A[a-f0-9]{64}\z")&&System.Text.RegularExpressions.Regex.IsMatch(parts[6],@"\A[0-9]{1,19}\z")&&ProfilePath(parts[0],parts[7]),"ACCOUNT_IDENTITY");return parts;}
  static void SaveCapsule(string root,string[] data){string path=System.IO.Path.Combine(root,"account.owner");PlainOwned(path,root);System.IO.File.WriteAllLines(path,data);}
  static void CleanupAccount(string root,long deadline,bool credentialClosed){
    Need(credentialClosed&&!AclJournalExists(root),"CLEANUP_UNVERIFIED");var data=Capsule(root);Need(data[4]=="SETUP"||data[4]=="RETIRED","CLEANUP_UNVERIFIED");var actual=Account(data[0]);Need(actual==null||(actual[0]==data[1]&&actual[1]=="lazysh-owned:"+data[2]),"ACCOUNT_IDENTITY");
    if(data[1]!=""&&data[3]=="1"){
      while(Hive(data[1])&&Environment.TickCount64<deadline)System.Threading.Thread.Sleep(10);
      Need(!Hive(data[1]),"CLEANUP_UNVERIFIED");
      if(Profile(data[1])){OwnedProfile(data[1],data[0],data[7]);Need(DeleteProfileW(data[1],null,null)&&!Profile(data[1]),"CLEANUP_UNVERIFIED");}Need(!System.IO.Directory.Exists(data[7])&&!System.IO.File.Exists(data[7]),"CLEANUP_UNVERIFIED");
    }
    if(data[1]!=""&&data[3]=="0")Need(!Profile(data[1])&&!Hive(data[1]),"CLEANUP_UNVERIFIED");
    if(actual!=null)Need(NetUserDel(null,data[0])==0&&Account(data[0])==null,"CLEANUP_UNVERIFIED");
    System.IO.File.Delete(System.IO.Path.Combine(root,"account.owner"));
  }
  public static void RecoverStandard(string root){HostedRoot(root);if(System.IO.File.Exists(System.IO.Path.Combine(root,"account.owner"))){var state=Capsule(root);if(state[4]=="ACL_RETIRING"){RetireDesktop(root);state[4]="RETIRED";SaveCapsule(root,state);}CleanupAccount(root,Environment.TickCount64+10000,true);}else Need(!AclJournalExists(root),"CLEANUP_UNVERIFIED");}
  OwnedMediumGui(bool accountOnly){Need(accountOnly,"ACCOUNT_IDENTITY");try{CreateOwnedJob();}catch{Dispose();throw;}}
  static void StandardToken(IntPtr process,string sid,uint session){IntPtr token=IntPtr.Zero;try{TokenNeed(OpenProcessToken(process,10,out token),TokenReason.STANDARD_TOKEN_OPEN);TokenNeed(TokenSid(token)==sid&&Word(token,8)==1&&Word(token,12)==session&&Word(token,20)==0&&Word(token,26)==0,TokenReason.STANDARD_TOKEN_IDENTITY);bool users=false;foreach(var group in Groups(token)){TokenNeed(!Admin(group)||(group.Attributes&4)==0,TokenReason.STANDARD_ADMIN_GROUP_ENABLED);if(Equal(group.Sid,new byte[]{1,2,0,0,0,0,0,5,32,0,0,0,33,2,0,0})&&(group.Attributes&4)!=0)users=true;}TokenNeed(users,TokenReason.STANDARD_USERS_GROUP_MISSING);var fact=OwnedGuiIntegrity.ReadToken(token);TokenNeed(fact[0]=="MEDIUM"&&fact[1]=="NOT_ELEVATED",TokenReason.STANDARD_TOKEN_INTEGRITY);}finally{if(token!=IntPtr.Zero)Need(CloseHandle(token),"CLEANUP_UNVERIFIED");}}
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenWindowStation(string name,bool inherit,uint access);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint access);
  [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr handle);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle,int kind,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  static byte[] ChildLogonSid(Group[] groups){
    byte[] result=null;foreach(var group in groups){if((group.Attributes&0xc0000000)==0)continue;Need((group.Attributes&0xc0000014)==0xc0000004&&result==null,"ACCOUNT_IDENTITY");byte[] sid=group.Sid;Need(sid.Length==20&&sid[0]==1&&sid[1]==3&&sid[2]==0&&sid[3]==0&&sid[4]==0&&sid[5]==0&&sid[6]==0&&sid[7]==5&&BitConverter.ToUInt32(sid,8)==5,"ACCOUNT_IDENTITY");result=sid;}
    Need(result!=null,"ACCOUNT_IDENTITY");return result;
  }
  static string LogonText(byte[] sid){return "S-1-5-5-"+BitConverter.ToUInt32(sid,12).ToString(CultureInfo.InvariantCulture)+"-"+BitConverter.ToUInt32(sid,16).ToString(CultureInfo.InvariantCulture);}
  static byte[] LogonBytes(string text){
    Need(System.Text.RegularExpressions.Regex.IsMatch(text??"",@"\AS-1-5-5-(?:0|[1-9][0-9]{0,9})-(?:0|[1-9][0-9]{0,9})\z"),"ACCOUNT_IDENTITY");var parts=text.Split('-');uint a=0,b=0;Need(UInt32.TryParse(parts[4],out a)&&UInt32.TryParse(parts[5],out b),"ACCOUNT_IDENTITY");byte[] sid=new byte[20]{1,3,0,0,0,0,0,5,5,0,0,0,0,0,0,0,0,0,0,0};Array.Copy(BitConverter.GetBytes(a),0,sid,12,4);Array.Copy(BitConverter.GetBytes(b),0,sid,16,4);return sid;
  }
  static byte[] LogonAce(byte[] sid,uint mask){Need(sid!=null&&sid.Length==20,"ACCOUNT_IDENTITY");Need(mask==2||mask==0x83,"FIXTURE_ACCESS");Need(Equal(LogonBytes(LogonText(sid)),sid),"ACCOUNT_IDENTITY");byte[] ace=new byte[28];ace[2]=28;Array.Copy(BitConverter.GetBytes(mask),0,ace,4,4);Array.Copy(sid,0,ace,8,20);return ace;}
  // Preserve every foreign ACE byte and its order. Never restore an old whole DACL.
  static byte[] LogonAcl(byte[] acl,byte[] sid,uint mask,bool remove){
    Need(acl!=null&&acl.Length>=8&&acl.Length<=65535&&(acl[0]==2||acl[0]==4)&&acl[1]==0&&acl[6]==0&&acl[7]==0&&BitConverter.ToUInt16(acl,2)==acl.Length,"FIXTURE_ACCESS");
    var entries=new System.Collections.Generic.List<byte[]>();byte[] own=LogonAce(sid,mask);int offset=8,found=0,count=BitConverter.ToUInt16(acl,4);
    for(int i=0;i<count;i++){Need(offset+4<=acl.Length,"FIXTURE_ACCESS");int size=BitConverter.ToUInt16(acl,offset+2);Need(size>=4&&size%4==0&&offset+size<=acl.Length,"FIXTURE_ACCESS");var entry=new byte[size];Array.Copy(acl,offset,entry,0,size);bool references=false;for(int j=4;j+sid.Length<=size;j++){bool match=true;for(int k=0;k<sid.Length;k++)match&=entry[j+k]==sid[k];references|=match;}
      if(references){Need(Equal(entry,own)&&++found==1&&remove,"FIXTURE_ACCESS");}else entries.Add(entry);offset+=size;
    }
    // Refuse unknown nonzero slack rather than silently discard descriptor payload.
    for(int i=offset;i<acl.Length;i++)Need(acl[i]==0,"FIXTURE_ACCESS");
    if(!remove)entries.Add(own);
    int length=8;foreach(var entry in entries)length+=entry.Length;Need(length<=65535&&entries.Count<=65535,"FIXTURE_ACCESS");var output=new byte[length];output[0]=acl[0];Array.Copy(BitConverter.GetBytes((ushort)length),0,output,2,2);Array.Copy(BitConverter.GetBytes((ushort)entries.Count),0,output,4,2);offset=8;foreach(var entry in entries){Array.Copy(entry,0,output,offset,entry.Length);offset+=entry.Length;}return output;
  }
  static byte[] UserObjectAcl(IntPtr handle){IntPtr owner,group,dacl,sacl,descriptor=IntPtr.Zero;try{Need(GetSecurityInfo(handle,7,4,out owner,out group,out dacl,out sacl,out descriptor)==0&&descriptor!=IntPtr.Zero&&IsValidSecurityDescriptor(descriptor)&&GetSecurityDescriptorLength(descriptor)<=65536&&dacl!=IntPtr.Zero,"FIXTURE_ACCESS");int length=unchecked((ushort)Marshal.ReadInt16(dacl,2));Need(length>=8&&length<=65535,"FIXTURE_ACCESS");byte[] bytes=new byte[length];Marshal.Copy(dacl,bytes,0,length);return bytes;}finally{if(descriptor!=IntPtr.Zero)Need(LocalFree(descriptor)==IntPtr.Zero,"CLEANUP_UNVERIFIED");}}
  static void WriteUserObjectAcl(IntPtr handle,byte[] before,byte[] after){
    Need(Equal(UserObjectAcl(handle),before),"FIXTURE_ACCESS");IntPtr data=Marshal.AllocHGlobal(after.Length);try{Marshal.Copy(after,0,data,after.Length);Need(SetSecurityInfo(handle,7,4,IntPtr.Zero,IntPtr.Zero,data,IntPtr.Zero)==0&&Equal(UserObjectAcl(handle),after),"FIXTURE_ACCESS");}finally{Marshal.FreeHGlobal(data);}
  }
  static void DesktopName(IntPtr handle,bool opened,bool station){
    string code=(station?"WINSTA_":"DESKTOP_")+(opened?"OPENED_NAME_UNAVAILABLE":"BORROWED_NAME_UNAVAILABLE");try{Need(ObjectName(handle)==(station?"WinSta0":"Default"),code);}catch(InvalidOperationException error){if(error.Message!="DESKTOP_UNAVAILABLE")throw;throw new InvalidOperationException(code);}
  }
  static void DesktopNames(bool opened,IntPtr station=default(IntPtr),IntPtr desktop=default(IntPtr)){
    DesktopName(opened?station:GetProcessWindowStation(),opened,true);DesktopName(opened?desktop:GetThreadDesktop(GetCurrentThreadId()),opened,false);
  }
  static void DesktopHandles(Action<IntPtr,IntPtr> use){
    IntPtr station=IntPtr.Zero,desktop=IntPtr.Zero;try{DesktopNames(false);station=OpenWindowStation("WinSta0",false,0x60000);desktop=OpenDesktop("Default",0,false,0x60081);Need(station!=IntPtr.Zero,"WINSTA_OPEN_UNAVAILABLE");Need(desktop!=IntPtr.Zero,"DESKTOP_OPEN_UNAVAILABLE");DesktopNames(true,station,desktop);use(station,desktop);}finally{bool closed=true;if(desktop!=IntPtr.Zero)closed&=CloseDesktop(desktop);if(station!=IntPtr.Zero)closed&=CloseWindowStation(station);Need(closed,"CLEANUP_UNVERIFIED");}
  }
  static bool AclJournalExists(string root){string path=System.IO.Path.Combine(root,"desktop.owner");PlainOwned(path,root);try{System.IO.File.GetAttributes(path);return true;}catch(System.IO.FileNotFoundException){return false;}}
  static void DurableAclJournal(string root,string[] data,bool create){
    string path=System.IO.Path.Combine(root,"desktop.owner");PlainOwned(path,root);if(create){using(var empty=new System.IO.FileStream(path,System.IO.FileMode.CreateNew,System.IO.FileAccess.Write)){}FixtureAcl(path,root,CurrentSid(),null,false);}
    byte[] bytes=System.Text.Encoding.UTF8.GetBytes(String.Join("\n",data));Need(bytes.Length<=2048,"FIXTURE_IDENTITY");using(var file=new System.IO.FileStream(path,System.IO.FileMode.Truncate,System.IO.FileAccess.Write,System.IO.FileShare.None,4096,System.IO.FileOptions.WriteThrough)){file.Write(bytes,0,bytes.Length);file.Flush(true);}
  }
  static void ValidateAclJournal(string[] data,string source,string parent,string[] capsule,uint session){
    Need(data!=null&&data.Length==8&&capsule!=null&&capsule.Length==8&&System.Text.RegularExpressions.Regex.IsMatch(source??"",@"\A[a-f0-9]{40}\z")&&data[0]==source&&StandardSid(parent)&&data[1]==parent&&data[2]==capsule[1]&&StandardSid(data[2])&&data[3]==capsule[2]&&System.Text.RegularExpressions.Regex.IsMatch(data[3]??"",@"\A[a-f0-9]{32}\z")&&(data[6]=="INTENT"||data[6]=="REMOVED")&&(data[7]=="INTENT"||data[7]=="REMOVED"),"FIXTURE_IDENTITY");LogonBytes(data[5]);Need(session!=0&&data[4]==session.ToString(CultureInfo.InvariantCulture),"DESKTOP_SESSION_UNAVAILABLE");
  }
  static string[] AclJournal(string root){
    string path=System.IO.Path.Combine(root,"desktop.owner");PlainOwned(path,root);Need(new System.IO.FileInfo(path).Length<=2048,"FIXTURE_IDENTITY");string[] data=System.IO.File.ReadAllLines(path);IntPtr caller=IntPtr.Zero;try{TokenNeed(OpenProcessToken(GetCurrentProcess(),8,out caller),TokenReason.OWN_TOKEN_OPEN);ValidateAclJournal(data,System.IO.File.ReadAllText(System.IO.Path.Combine(root,"fixture.owner")),CurrentSid(),Capsule(root),Word(caller,12));}finally{if(caller!=IntPtr.Zero)Need(CloseHandle(caller),"CLEANUP_UNVERIFIED");}return data;
  }
  static void ProvisionDesktop(string root,IntPtr process,IntPtr credential,uint session){
    byte[] sid=null;InspectAs(credential,()=>{IntPtr child=IntPtr.Zero;try{TokenNeed(OpenProcessToken(process,8,out child),TokenReason.STANDARD_TOKEN_OPEN);sid=ChildLogonSid(Groups(child));}finally{if(child!=IntPtr.Zero)Need(CloseHandle(child),"CLEANUP_UNVERIFIED");}});
    DesktopHandles((station,desktop)=>{byte[] a=UserObjectAcl(station),b=UserObjectAcl(desktop),nextA=LogonAcl(a,sid,2,false),nextB=LogonAcl(b,sid,0x83,false);string[] capsule=Capsule(root);Need(capsule[4]=="INTENT","FIXTURE_IDENTITY");DurableAclJournal(root,new[]{System.IO.File.ReadAllText(System.IO.Path.Combine(root,"fixture.owner")),CurrentSid(),capsule[1],capsule[2],session.ToString(CultureInfo.InvariantCulture),LogonText(sid),"INTENT","INTENT"},true);WriteUserObjectAcl(station,a,nextA);WriteUserObjectAcl(desktop,b,nextB);});
  }
  static void RetireDesktop(string root){
    string path=System.IO.Path.Combine(root,"desktop.owner");if(!AclJournalExists(root))return;Need(Capsule(root)[4]=="ACL_RETIRING","CLEANUP_UNVERIFIED");string[] data=AclJournal(root);byte[] sid=LogonBytes(data[5]);DesktopHandles((station,desktop)=>{IntPtr[] handles={station,desktop};uint[] masks={2,0x83};for(int i=0;i<2;i++){byte[] before=UserObjectAcl(handles[i]),after=LogonAcl(before,sid,masks[i],true);if(data[6+i]=="REMOVED")Need(Equal(before,after),"CLEANUP_UNVERIFIED");else{WriteUserObjectAcl(handles[i],before,after);data[6+i]="REMOVED";DurableAclJournal(root,data,false);}}});System.IO.File.Delete(path);
  }
  public static string RunStandard(string root,string image,string worker,string imageHash,long deadline){
    HostedRoot(root);PlainOwned(image,root);PlainOwned(worker,root);Need(deadline>Environment.TickCount64&&deadline-Environment.TickCount64<=650000,"ACCOUNT_BUDGET");DesktopNames(false);
    string parent=CurrentSid(),name="lshci"+Guid.NewGuid().ToString("N").Substring(0,12),nonce=Guid.NewGuid().ToString("N");Need(Account(name)==null,"ACCOUNT_COLLISION");string expectedProfile=ExpectedProfile(name);Need(!System.IO.Directory.Exists(expectedProfile)&&!System.IO.File.Exists(expectedProfile),"PROFILE_COLLISION");
    Need(System.Text.RegularExpressions.Regex.IsMatch(imageHash??"",@"\A[a-f0-9]{64}\z"),"IDENTITY_UNVERIFIED");using(var hash=System.Security.Cryptography.SHA256.Create())using(var file=System.IO.File.OpenRead(image))Need(Convert.ToHexString(hash.ComputeHash(file)).ToLowerInvariant()==imageHash,"IDENTITY_UNVERIFIED");
    string capsule=System.IO.Path.Combine(root,"account.owner");using(var empty=new System.IO.FileStream(capsule,System.IO.FileMode.CreateNew,System.IO.FileAccess.Write)){}FixtureAcl(capsule,root,parent,null,false);SaveCapsule(root,new[]{name,"",nonce,"0","SETUP",imageHash,"0",expectedProfile});
    IntPtr password=Marshal.AllocHGlobal(98),accountName=IntPtr.Zero,comment=IntPtr.Zero,caller=IntPtr.Zero,credential=IntPtr.Zero;OwnedMediumGui owned=null;PI child=new PI();bool retained=false,creationAttempted=false,creationReturned=false;string outcome="STANDARD_OWNER_FAILED",primary="UNVERIFIED";
    try{
      byte[] random=new byte[48];System.Security.Cryptography.RandomNumberGenerator.Fill(random);const string alphabet="abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%";
      for(int i=0;i<48;i++)Marshal.WriteInt16(password,i*2,(short)alphabet[random[i]%alphabet.Length]);Marshal.WriteInt16(password,0,(short)'a');Marshal.WriteInt16(password,2,(short)'A');Marshal.WriteInt16(password,4,(short)'1');Marshal.WriteInt16(password,6,(short)'!');Marshal.WriteInt16(password,96,0);Array.Clear(random,0,random.Length);
      accountName=Marshal.StringToHGlobalUni(name);comment=Marshal.StringToHGlobalUni("lazysh-owned:"+nonce);var info=new AccountInfo{Name=accountName,Password=password,Privilege=1,Comment=comment,Flags=0x201};uint parameter;Need(NetUserAdd(null,1,ref info,out parameter)==0,"ACCOUNT_CREATE_UNAVAILABLE");
      var actual=Account(name);Need(actual!=null&&actual[1]=="lazysh-owned:"+nonce,"ACCOUNT_IDENTITY");SaveCapsule(root,new[]{name,actual[0],nonce,"0","SETUP",imageHash,"0",expectedProfile});OrdinaryMembership(actual[0]);Need(!Profile(actual[0])&&!Hive(actual[0]),"PROFILE_COLLISION");SaveCapsule(root,new[]{name,actual[0],nonce,"1","SETUP",imageHash,"0",expectedProfile});
      int fixtureCount=0;FixtureTree(root,root,parent,actual[0],ref fixtureCount,0);FixtureAcl(capsule,root,parent,null,false);
      TokenNeed(OpenProcessToken(GetCurrentProcess(),8,out caller),TokenReason.OWN_TOKEN_OPEN);uint session=Word(caller,12);Need(session!=0,"DESKTOP_SESSION_UNAVAILABLE");owned=new OwnedMediumGui(true);
      Need(LogonUserW(name,".",password,2,0,out credential)&&credential!=IntPtr.Zero,"STANDARD_LOGON_UNAVAILABLE");TokenNeed(TokenSid(credential)==actual[0],TokenReason.STANDARD_TOKEN_IDENTITY);
      var startup=new SI{Size=Marshal.SizeOf(typeof(SI)),Desktop="winsta0\\default"};string command=Command(image,new[]{"run",worker});
      // NULL environment asks Windows for this account's profile environment, never the parent's CI environment.
      SaveCapsule(root,new[]{name,actual[0],nonce,"1","INTENT",imageHash,DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture),expectedProfile});
      creationAttempted=true;bool created=CreateProcessWithLogonW(name,".",password,1,image,new System.Text.StringBuilder(command),0x08000004,IntPtr.Zero,root,ref startup,out child);creationReturned=true;for(int i=0;i<98;i++)Marshal.WriteByte(password,i,0);Need(created,"STANDARD_LOGON_UNAVAILABLE");
      long start=owned.VerifyCreated(child,image,credential);using(var hash=System.Security.Cryptography.SHA256.Create())using(var file=System.IO.File.OpenRead(image))Need(Convert.ToHexString(hash.ComputeHash(file)).ToLowerInvariant()==imageHash,"IDENTITY_UNVERIFIED");InspectAs(credential,()=>StandardToken(child.Process,actual[0],session));Need(Profile(actual[0])&&Hive(actual[0]),"PROFILE_IDENTITY");OwnedProfile(actual[0],name,expectedProfile);
      ProvisionDesktop(root,child.Process,credential,session);
      WithDesktopToken(credential,child.Process,impersonation=>Need(CheckDacl(GetProcessWindowStation(),impersonation,2,3)=="ALLOWS"&&CheckDacl(GetThreadDesktop(GetCurrentThreadId()),impersonation,3,4)=="ALLOWS",StandardDesktopFailure()));
      var process=System.Diagnostics.Process.GetProcessById(child.Id);try{Need(process.StartTime.ToUniversalTime().Ticks==start,"IDENTITY_UNVERIFIED");long remaining=deadline-Environment.TickCount64-15000;Need(remaining>0&&remaining<=650000,"ACCOUNT_BUDGET");Need(ResumeThread(child.Thread)==1,"LAUNCH_UNAVAILABLE");owned.processes.Add(child.Process);child.Process=IntPtr.Zero;retained=true;
        Need(process.WaitForExit((int)remaining),"STANDARD_OWNER_TIMEOUT");Need(process.ExitCode==0,"STANDARD_OWNER_FAILED");outcome="STANDARD_OWNER_PASSED";
      }finally{process.Dispose();}
    }catch(Exception failure){primary=StandardPrimaryFailure(failure.GetBaseException().Message);throw;}finally{
      bool clean=!creationAttempted||creationReturned;
      if(!retained&&child.Process!=IntPtr.Zero){clean&=TerminateProcess(child.Process,1);clean&=WaitForSingleObject(child.Process,10000)==0;clean&=CloseHandle(child.Process);}
      if(child.Thread!=IntPtr.Zero)clean&=CloseHandle(child.Thread);if(caller!=IntPtr.Zero)clean&=CloseHandle(caller);
      if(owned!=null)try{owned.Stop(DateTime.UtcNow.AddSeconds(10).Ticks);}catch{clean=false;}
      bool credentialClosed=credential==IntPtr.Zero||CloseHandle(credential);if(credentialClosed)credential=IntPtr.Zero;clean&=credentialClosed;
      for(int i=0;i<98;i++)Marshal.WriteByte(password,i,0);Marshal.FreeHGlobal(password);if(accountName!=IntPtr.Zero)Marshal.FreeHGlobal(accountName);if(comment!=IntPtr.Zero)Marshal.FreeHGlobal(comment);
      try{if(clean){var state=Capsule(root);state[4]="ACL_RETIRING";SaveCapsule(root,state);RetireDesktop(root);state[4]="RETIRED";SaveCapsule(root,state);}CleanupAccount(root,Math.Min(deadline,Environment.TickCount64+10000),credentialClosed);}catch{clean=false;}
      if(!clean)throw new InvalidOperationException("CLEANUP_UNVERIFIED:"+primary);
    }return outcome;
  }
}
`;


export function standardOwnerCode(value:unknown){
  if(typeof value!=='string')return 'UNVERIFIED';
  const parts=value.split(':');
  if(parts[0]!=='LAZYSH_STANDARD_OWNER')return 'UNVERIFIED';
  if(parts.length===2&&standardCodes.some(code=>code===parts[1]))return parts[1];
  return parts.length===3&&parts[1]==='CLEANUP_UNVERIFIED'&&(parts[2]==='UNVERIFIED'||standardCodes.some(code=>code!== 'STANDARD_OWNER_PASSED'&&code===parts[2]))?'CLEANUP_UNVERIFIED':'UNVERIFIED';
}
export function parseStandardReceipt(value:unknown,source:string,binary:string):{result:'PASSED'|'FAILED';failure?:string}{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Standard owner receipt rejected');
  const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(',');
  if(!['binary,result,source','binary,failure,result,source'].includes(keys)||row.source!==source||row.binary!==binary||!['PASSED','FAILED'].includes(row.result as string)||!(/^[a-f0-9]{40}$/.test(source))||!(/^[a-f0-9]{64}$/.test(binary)))throw new Error('Standard owner receipt rejected');
  if(row.failure!==undefined&&(row.result!=='FAILED'||typeof row.failure!=='string'||windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+row.failure)!==row.failure))throw new Error('Standard owner failure rejected');
  return {result:row.result as 'PASSED'|'FAILED',...(typeof row.failure==='string'?{failure:row.failure}:{})};
}
export const standardSourceFiles=['package.json','apps/client/package.json','apps/client/vitest.native-gui.config.ts','apps/client/native-e2e/policy.ts','apps/client/native-e2e/windows/installed.spec.ts','.changeset/bun-lock.ts','.changeset/release-artifacts.ts','.changeset/release-platform.ts','.changeset/windows-installed-gui.ts','.changeset/windows-standard-user.ts'] as const;
function hostedStandardScope(env:NodeJS.ProcessEnv){
  if(process.platform!=='win32'||env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.GITHUB_REPOSITORY!=='mihazs/lazysh'||!/^\d{1,20}$/.test(env.GITHUB_RUN_ID??'')||!/^\d{1,20}$/.test(env.GITHUB_RUN_ATTEMPT??'')||!env.RUNNER_TEMP||!env.GITHUB_ENV||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??''))throw new Error('Standard owner requires verified disposable hosted Windows CI');
  return join(resolve(env.RUNNER_TEMP),`lazysh-standard-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
}
export function insideStandardRoot(path:string,root:string){const name=relative(resolve(root),resolve(path));return name===''||(!name.startsWith('..'+sep)&&name!=='..'&&!name.startsWith(sep)&&!name.includes(':'));}
export async function copyStandardClosure(source:string,target:string,allowed:string,visited=new Set<string>(),budget={files:0,bytes:0}){
  const actual=await realpath(source);if(!insideStandardRoot(actual,allowed)||visited.has(actual))throw new Error('Standard fixture dependency escapes its allowed closure');
  const entry=await lstat(actual);if(entry.isDirectory()){
    const next=new Set(visited);next.add(actual);await mkdir(target,{recursive:true});
    for(const child of await readdir(actual)){
      // No workspace links, executable shims or generated cache/profile content belongs to this owner.
      if(child==='@lazysh'||(child.startsWith('.')&&child!=='.crates2.json'))continue;
      await copyStandardClosure(join(actual,child),join(target,child),allowed,next,budget);
    }
  }else{
    if(!entry.isFile()||++budget.files>50000||(budget.bytes+=entry.size)>1_073_741_824)throw new Error('Standard fixture closure exceeds its bound');
    await mkdir(dirname(target),{recursive:true});await copyFile(actual,target);
    if((await digestFile(actual)).sha256!==(await digestFile(target)).sha256)throw new Error('Standard fixture copy changed identity');
  }
}
const inheritedStandardKeys=new Set(['SYSTEMROOT','WINDIR','COMSPEC','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','USERPROFILE','APPDATA','LOCALAPPDATA','USERNAME','USERDOMAIN','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','PATHEXT']);
const configuredStandardKeys=['GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_SHA','RUNNER_TEMP','TEMP','TMP','PATH','LAZYSH_TEST_WINDOWS_GUI','LAZYSH_GUI_DRIVER','LAZYSH_GUI_EDGE'];
export function standardWorkerEnvironment(current:NodeJS.ProcessEnv,configured:Record<string,string>):NodeJS.ProcessEnv{
  if(Object.keys(configured).sort().join(',')!==[...configuredStandardKeys].sort().join(',')||Object.values(configured).some(value=>typeof value!=='string'||value.includes('\0')))throw new Error('Standard child environment rejected');
  const selected=Object.fromEntries(Object.entries(current).filter(([key,value])=>inheritedStandardKeys.has(key.toUpperCase())&&value!==undefined));
  return {...selected,...configured};
}
const standardWorker=String.raw`
import {readFile,writeFile} from 'node:fs/promises';
import {windowsInstallation,windowsInstallerFailure} from './.changeset/release-platform';
import {standardWorkerEnvironment} from './.changeset/windows-standard-user';
const config=JSON.parse(await readFile(new URL('./owner.json',import.meta.url),'utf8'));
const selected=standardWorkerEnvironment(process.env,config.environment);
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,selected);
let result='FAILED',failure;
try{
 const output=await windowsInstallation(config.installer,config.binary,config.version,true,true);
 if(!output.includes('Windows installed GUI bundled version, source, image and owned window passed')||!output.endsWith('Windows NSIS install, same-version repair, marker preservation and uninstall passed'))throw new Error('Incomplete owner');
 result='PASSED';
}catch(error){
 const match=error instanceof Error?error.message.match(/^Release validation failed: pwsh.exe \(([^)\n]{1,256})\)/):null;
 if(match)failure=windowsInstallerFailure('LAZYSH_WINDOWS_INSTALLER:'+match[1]);
}
await writeFile(new URL('./work/result.json',import.meta.url),JSON.stringify({result,source:config.environment.GITHUB_SHA,binary:config.binaryHash,...(failure?{failure}:{})}),{flag:'wx'});
if(result!=='PASSED')process.exitCode=1;
`;
export const standardBrokerScript=String.raw`$ErrorActionPreference='Stop';try{Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop;$result=[OwnedMediumGui]::RunStandard($env:LAZYSH_WINDOWS_STANDARD_ROOT,(Join-Path $env:LAZYSH_WINDOWS_STANDARD_ROOT 'bin/bun.exe'),(Join-Path $env:LAZYSH_WINDOWS_STANDARD_ROOT 'worker.ts'),$env:LAZYSH_STANDARD_IMAGE_HASH,([Environment]::TickCount64+[long]$env:LAZYSH_STANDARD_REMAINING));[Console]::Out.Write('LAZYSH_STANDARD_OWNER:'+$result)}catch{$code=$_.Exception.GetBaseException().Message;if($code -ceq 'TOKEN_UNAVAILABLE'){$code=[OwnedMediumGui]::StandardTokenFailure()};if($code -cnotin @(${standardCodes.map(code=>"'"+code+"'").join(',')}) -and !($code -cmatch '\ACLEANUP_UNVERIFIED:([A-Z_]+)\z' -and $matches[1] -cin @('UNVERIFIED',${standardCodes.filter(code=>code!=='STANDARD_OWNER_PASSED').map(code=>"'"+code+"'").join(',')}))){$code='UNVERIFIED'};[Console]::Out.Write('LAZYSH_STANDARD_OWNER:'+$code)}`;
export async function windowsStandardInstallation(installer:string,binary:string,version:string){
  const root=hostedStandardScope(process.env),started=Date.now(),deadline=started+650000;
  await mkdir(root);await writeFile(join(root,'fixture.owner'),process.env.GITHUB_SHA!,{flag:'wx'});
  await appendFile(process.env.GITHUB_ENV!,`LAZYSH_WINDOWS_STANDARD_ROOT=${root}\n`);
  let completed=false;
  try{
    const source=resolve(import.meta.dir,'..');
    for(const path of standardSourceFiles){const from=join(source,path);if(!insideStandardRoot(await realpath(from),source)||(await lstat(from)).isSymbolicLink())throw new Error('Standard source cannot be a link');await mkdir(dirname(join(root,path)),{recursive:true});await copyFile(from,join(root,path));if((await digestFile(from)).sha256!==(await digestFile(join(root,path))).sha256)throw new Error('Standard source copy changed identity');}
    await copyStandardClosure(join(source,'node_modules'),join(root,'node_modules'),join(source,'node_modules'));
    await mkdir(join(root,'bin'));for(const path of standardWritableDirectories)await mkdir(join(root,path),{recursive:true});await mkdir(join(root,'work','temp'));
    const node=(await native('node',['-p','process.execPath'])).trim();
    const pwsh=(await native('pwsh.exe',['-NoProfile','-NonInteractive','-Command','[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'])).trim();
    if(!insideStandardRoot(pwsh,process.env.ProgramFiles??'')||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Standard system tool scope unavailable');
    for(const [from,to] of [[process.execPath,join(root,'bin','bun.exe')],[node,join(root,'bin','node.exe')],[binary,join(root,'binary.exe')],[installer,join(root,'installer.exe')]] as const){if(!(await lstat(from)).isFile()||(await lstat(from)).isSymbolicLink())throw new Error('Standard artifact must be a regular file');await copyFile(from,to);if((await digestFile(from)).sha256!==(await digestFile(to)).sha256)throw new Error('Standard artifact copy changed identity');}
    const driverRoot=dirname(dirname(process.env.LAZYSH_GUI_DRIVER??''));
    if(!insideStandardRoot(driverRoot,process.env.RUNNER_TEMP!))throw new Error('Standard driver scope unavailable');
    await copyStandardClosure(driverRoot,join(root,'tools'),driverRoot);
    const binaryHash=(await digestFile(join(root,'binary.exe'))).sha256;
    const environment={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'mihazs/lazysh',GITHUB_SHA:process.env.GITHUB_SHA!,RUNNER_TEMP:join(root,'work'),TEMP:join(root,'work','temp'),TMP:join(root,'work','temp'),PATH:[join(root,'bin'),dirname(pwsh),join(process.env.SystemRoot!,'System32')].join(';'),LAZYSH_TEST_WINDOWS_GUI:'1',LAZYSH_GUI_DRIVER:join(root,'tools','bin','tauri-driver.exe'),LAZYSH_GUI_EDGE:join(root,'tools','edge','msedgedriver.exe')};
    await writeFile(join(root,'owner.json'),JSON.stringify({environment,installer:join(root,'installer.exe'),binary:join(root,'binary.exe'),binaryHash,version}),{flag:'wx'});await writeFile(join(root,'worker.ts'),standardWorker,{flag:'wx'});
    const remaining=deadline-Date.now()-1000;if(remaining<=15000)throw new Error('Standard owner setup exhausted its budget');
    const script=standardBrokerScript;
    const imageHash=(await digestFile(join(root,'bin','bun.exe'))).sha256;
    const wire=await native(pwsh,['-NoProfile','-NonInteractive','-Command',script],{...process.env,LAZYSH_WINDOWS_STANDARD_ROOT:root,LAZYSH_STANDARD_REMAINING:String(remaining),LAZYSH_STANDARD_IMAGE_HASH:imageHash},remaining,windowsStandardUserSource);
    let receipt:ReturnType<typeof parseStandardReceipt>|undefined;
    const resultFile=join(root,'work','result.json');
    if(await Bun.file(resultFile).exists()){const entry=await lstat(resultFile);if(!entry.isFile()||entry.isSymbolicLink()||!insideStandardRoot(await realpath(resultFile),root))throw new Error('Standard owner receipt escapes its scope');if(entry.size>2048)throw new Error('Standard owner receipt exceeds its bound');receipt=parseStandardReceipt(JSON.parse(await readFile(resultFile,'utf8')),process.env.GITHUB_SHA!,binaryHash);}
    if(standardOwnerCode(wire)!=='STANDARD_OWNER_PASSED')throw new Error('Standard native owner rejected: '+standardOwnerCode(wire)+(typeof wire==='string'&&standardOwnerCode(wire)==='CLEANUP_UNVERIFIED'&&wire.split(':').length===3?' primary='+wire.split(':')[2]:'')+(receipt?.failure?' ('+receipt.failure+')':''));
    if(receipt?.result!=='PASSED')throw new Error('Standard owner receipt rejected');
    completed=true;return 'Windows ordinary-user NSIS, installed GUI and owned account cleanup passed';
  }finally{
    if(!(await readdir(root)).some(name=>name==='account.owner'||name==='desktop.owner')){await removeStandardFixture(root);}
    else if(completed)throw new Error('Standard account cleanup is unverified');
  }
}

export async function removeStandardFixture(root:string){
  if(await readFile(join(root,'fixture.owner'),'utf8')!==process.env.GITHUB_SHA)throw new Error('Standard fixture ownership changed');
  const inspect=async(path:string):Promise<void>=>{const entry=await lstat(path);if(entry.isSymbolicLink())throw new Error('Standard cleanup refuses reparse data');if(entry.isDirectory())for(const name of await readdir(path))await inspect(join(path,name));};
  await inspect(root);await rm(root,{recursive:true});
}
export async function recoverWindowsStandard(){
  const expected=hostedStandardScope(process.env),root=process.env.LAZYSH_WINDOWS_STANDARD_ROOT;
  if(!root)return;
  if(root!==expected)throw new Error('Standard recovery scope changed');
  try{await lstat(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!await Bun.file(join(root,'fixture.owner')).exists())throw new Error('Standard recovery marker missing');
  if(await readFile(join(root,'fixture.owner'),'utf8')!==process.env.GITHUB_SHA)throw new Error('Standard recovery identity changed');
  await native('pwsh.exe',['-NoProfile','-NonInteractive','-Command',String.raw`$ErrorActionPreference='Stop';try{Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop;[OwnedMediumGui]::RecoverStandard($env:LAZYSH_WINDOWS_STANDARD_ROOT);[Console]::Out.Write('STANDARD_RECOVERED')}catch{exit 1}`],process.env,20000,windowsStandardUserSource);
  await removeStandardFixture(root);
}
if(import.meta.main){if(process.argv[2]!=='--recover')throw new Error('Explicit standard recovery required');await recoverWindowsStandard();}
