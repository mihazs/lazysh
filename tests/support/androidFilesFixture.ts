import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {OwnedProcess} from './ownedProcess';

/** Facts the instrumentation needs; every path is relative to the sshd account's home. */
export type FilesFixture={directory:string;repository:string;firstCommit:string;note:string;firstReadme:string;secondReadme:string;untracked:string};

const git=(repository:string,args:string[])=>new OwnedProcess('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
  '-c','commit.gpgsign=false','-C',repository,...args],undefined,{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'})
  .finish(`owned repository git ${args[0]}`,10_000);

/**
 * Plain files for the Files case and a Git repository for the review case under `home/browse`: a text file, a
 * file that is not UTF-8, a file one byte over the 1 MiB preview limit, and a repository with two commits plus a
 * modified text file, a modified binary file, a staged addition and an untracked file in its working tree.
 */
export async function writeFilesFixture(home:string,nonce:string):Promise<FilesFixture> {
  const directory='browse',repository=`${directory}/review`,root=join(home,repository);
  const fixture:FilesFixture={directory,repository,firstCommit:'',note:`FILES_NOTE_${nonce}`,firstReadme:`# Review first ${nonce}`,secondReadme:`# Review second ${nonce}`,untracked:`UNTRACKED_${nonce}`};
  await mkdir(join(root,'docs'),{recursive:true,mode:0o700});
  await mkdir(join(root,'notes'),{mode:0o700});
  await writeFile(join(home,directory,'notes.txt'),`${fixture.note}\nsecond line\n`);
  await writeFile(join(home,directory,'blob.bin'),Buffer.from([0xff,0xfe,0x00,0x80]));
  await writeFile(join(home,directory,'huge.txt'),Buffer.alloc(1024*1024+1,0x61));
  await git(root,['init','-q']);
  await writeFile(join(root,'file.txt'),'before\n');
  await writeFile(join(root,'docs/readme.md'),`${fixture.firstReadme}\n`);
  await writeFile(join(root,'data.bin'),Buffer.from([0x00,0x01,0x02,0x03]));
  await git(root,['add','--','file.txt','docs/readme.md','data.bin']);
  await git(root,['commit','-qm','first commit']);
  fixture.firstCommit=(await git(root,['rev-parse','HEAD'])).trim();
  await writeFile(join(root,'docs/readme.md'),`${fixture.secondReadme}\n\n- item\n`);
  await git(root,['commit','-qam','second commit']);
  await writeFile(join(root,'file.txt'),'after\n');
  await writeFile(join(root,'data.bin'),Buffer.from([0x00,0x01,0x02,0x04]));
  await writeFile(join(root,'staged-new.txt'),'staged addition\n');
  await git(root,['add','--','staged-new.txt']);
  await writeFile(join(root,'notes/untracked.txt'),`${fixture.untracked}\n`);
  return fixture;
}
