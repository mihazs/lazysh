export const syncEndpoint='https://dav.example.invalid/lazysh/';
export const syncUsername='synthetic WebDAV user {{literal}}';
export const syncPassword='synthetic password <not a user secret>';
export const syncRecovery='AGE-SECRET-KEY-SYNTHETIC-TEST-ONLY';
export const syncHost={id:'literal-host',name:'Host {{literal}} <img> 中文',hostname:'sync-host.invalid',username:'agent',port:2222,fingerprint:'SHA256:literal/{{fingerprint}}',jumpHostId:'jump:{{literal}}',forwardAgent:true,addHost:true,trustFingerprint:true};
export const syncConflict={id:'remote:{{id}}',reason:'syncInvalidPreview <remote> {{literal}} /remote/path'};
export const syncStatus={configured:true,endpoint:syncEndpoint,username:syncUsername,settingsEnabled:true,credentialsEnabled:true};
export function syncPreview(scope:'settings'|'credentials'='settings') {return {token:'original-preview-token',scope,hosts:[{...syncHost,importCredentials:scope==='credentials'}],conflicts:[syncConflict]};}
