// Regenerate checked-in Bed Mode platform exports using Node 22+.
import {png, ico, icns} from './raster.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
function save(path,bytes){const full=resolve(root,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,bytes);}
const cache=new Map();
function get(n,variant){const key=variant+':'+n;if(!cache.has(key))cache.set(key,png(n,variant));return cache.get(key);}
const icons='apps/client/src-tauri/icons/';
for(const [file,n] of [['32x32.png',32],['128x128.png',128],['128x128@2x.png',256],['icon.png',512]])save(icons+file,get(n,'wrapped'));
save(icons+'icon.ico',ico([16,24,32,48,64,256].map(n=>[n,get(n,'wrapped')])));
save(icons+'icon.icns',icns([['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]].map(([type,n])=>[type,get(n,'wrapped')])));
for(const [density,scale] of [['mdpi',1],['hdpi',1.5],['xhdpi',2],['xxhdpi',3],['xxxhdpi',4]]) {
 const p='apps/client/src-tauri/gen/android/app/src/main/res/mipmap-'+density+'/';
 save(p+'ic_launcher.png',get(48*scale,'wrapped'));
 save(p+'ic_launcher_round.png',get(48*scale,'round'));
 save(p+'ic_launcher_foreground.png',get(108*scale,'foreground'));
}
for(const [name,n] of [['20x20@1x',20],['20x20@2x',40],['20x20@2x-1',40],['20x20@3x',60],['29x29@1x',29],['29x29@2x',58],['29x29@2x-1',58],['29x29@3x',87],['40x40@1x',40],['40x40@2x',80],['40x40@2x-1',80],['40x40@3x',120],['60x60@2x',120],['60x60@3x',180],['76x76@1x',76],['76x76@2x',152],['83.5x83.5@2x',167],['512@2x',1024]]) {
 save(icons+'ios/AppIcon-'+name+'.png',get(n,'ios'));
}
save('brand/lazysh/platform/play-store-512.png',get(512,'ios'));
save('brand/lazysh/platform/favicon-16.png',get(16,'wrapped'));
save('brand/lazysh/platform/favicon-32.png',get(32,'wrapped'));
