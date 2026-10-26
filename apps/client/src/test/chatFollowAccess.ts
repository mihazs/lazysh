import {accessSnapshot,applyAccessStatus} from '../access';
export function chatFollowAccess(locked=false) {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic Follow fixture',enabled:true,locked,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});
}
