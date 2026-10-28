import {downloadNotoFont} from '../../src/fontDownload';
import {getDeviceFonts,initializeFonts} from '../../src/fonts';
initializeFonts();
/** Pure module bootstrapping allows the unmodified native script/connect CSP. */
export const policy={
  ready:()=>getDeviceFonts().ready,
  async download(){
    try {await downloadNotoFont(new AbortController().signal,()=>true);return 'imported';}
    catch(error){return String(error);}
  },
};
Object.assign(window,{notoPolicy:policy});
