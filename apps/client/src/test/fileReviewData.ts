/** Synthetic file/revision records shared by renderer and browser acceptance. */
export const fileReviewSession = 'ssh:literal-file-review';
export const fileReviewRoot = '/literal/repositório';
export const fileReviewName = 'unchanged.ts';
export const fileReviewSource = 'const literal = "<img src=secret onerror=alert(1)>";\n// unchanged user content';
export const fileReviewOid = 'b'.repeat(40);
export const fileReviewPatch = '@@ -1 +1 @@\n-before literal\n+after literal';
export function fileReviewReply(command: string): unknown {
  if (command === 'list_directory') return [{name:fileReviewName,isDir:false,size:12500}];
  if (command === 'read_file') return fileReviewSource;
  if (command === 'upload_file') return undefined;
  if (command === 'get_diff') return fileReviewPatch;
  if (command === 'repository_status') return {path:fileReviewRoot,changes:[{path:fileReviewName,originalPath:null,index:'M',worktree:'M'}]};
  if (command === 'repository_history') return [{oid:fileReviewOid,subject:'Literal commit subject'}];
  if (command === 'repository_tree') return [{path:fileReviewName,oid:fileReviewOid,kind:'blob',size:12500}];
  if (command === 'repository_blob') return {text:fileReviewSource,binary:false,bytes:12500};
  if (command === 'repository_diff') return {patch:fileReviewPatch,binary:false};
  throw new Error('Unexpected file-review fixture command');
}
