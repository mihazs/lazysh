import type {Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const token='11111111-1111-4111-8111-111111111111';
const picker=await readFile(new URL('../../src/previewPicker.js',import.meta.url),'utf8');
export async function routePreviewPage(page: Page, blocked=false) {
  await page.route('http://127.0.0.1:41234/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: blocked ? { 'Content-Security-Policy': "script-src 'none'" } : {}, body: `<!doctype html><html><head><style>body{font:18px sans-serif}button{padding:15px}section{padding:20px}textarea,input{display:block}</style></head><body><section><button id="save">Save changes</button><input aria-label="Password" type="password" value="never-copy-password"><textarea>never-copy-textarea</textarea><span contenteditable="true">never-copy-editable</span><span style="visibility:hidden">never-copy-css-hidden</span><div style="opacity:0"><span>never-copy-transparent-ancestor</span></div></section><script>for(const type of ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','click','keydown','keyup'])document.getElementById('save').addEventListener(type,()=>document.body.dataset[type]=String(Number(document.body.dataset[type]||0)+1))</script></body></html><script data-lazysh-picker="${token}">${picker}</script>` }));
}
