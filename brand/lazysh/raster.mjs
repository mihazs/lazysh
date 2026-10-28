// Pure JavaScript rasterizer and PNG encoder for the Bed Mode brand mark.
// No DOM, canvas, native dependencies or external libraries required.
const HEAD=[[[51,185],[39,169],[37,151],[40,119]],[[40,119],[44,81],[74,60],[105,61]],[[105,61],[138,62],[156,82],[160,112]],[[160,112],[164,142],[175,155],[191,158]]];
function polyCubic(group, p0,p1,p2,p3,n=15){let prev=p0;for(let i=1;i<=n;i++){const t=i/n,s=1-t,p=[0,1].map(k=>s*s*s*p0[k]+3*s*s*t*p1[k]+3*s*t*t*p2[k]+t*t*t*p3[k]);group.push([prev,p]);prev=p;}}
function polyQuad(group,p0,p1,p2,n=12){polyCubic(group,p0,[p0[0]+2*(p1[0]-p0[0])/3,p0[1]+2*(p1[1]-p0[1])/3],[p2[0]+2*(p1[0]-p2[0])/3,p2[1]+2*(p1[1]-p2[1])/3],p2,n);}
const paths=[];
function group(width,segments){for(const [a,b] of segments){const dx=b[0]-a[0],dy=b[1]-a[1];paths.push({x:a[0],y:a[1],dx,dy,inv:1/(dx*dx+dy*dy),r:width/2});}}
const h=[];for(const c of HEAD)polyCubic(h,...c);group(10.5,h);
const b=[];polyQuad(b,[51,185],[58,189],[70,189]);b.push([[70,189],[223,189]]);group(10.5,b);
const p=[[[169,186],[188,143]]];polyQuad(p,[188,143],[190,137],[198,137]);p.push([[198,137],[225,137]],[[225,137],[210,183]]);polyQuad(p,[210,183],[209,187],[203,187]);p.push([[203,187],[169,187]]);group(9.5,p);
const eyeL=[];polyQuad(eyeL,[77,139],[84,147],[94,138]);group(6.3,eyeL);
const eyeR=[];polyQuad(eyeR,[111,139],[119,147],[129,138]);group(6.3,eyeR);
function clamp(x){return Math.max(0,Math.min(1,x));}
function roundRectSDF(x,y){const dx=Math.abs(x-128)-67,dy=Math.abs(y-128)-67;return Math.hypot(Math.max(dx,0),Math.max(dy,0))+Math.min(Math.max(dx,dy),0)-53;}
function markCoverage(x,y,step,scaleW=1){if(x<27||x>238||y<48||y>204)return 0;let best=-1;for(const s of paths){const ox=x-s.x,oy=y-s.y,t=clamp((ox*s.dx+oy*s.dy)*s.inv),xx=ox-t*s.dx,yy=oy-t*s.dy,d=s.r*scaleW-Math.sqrt(xx*xx+yy*yy);if(d>best)best=d; if(d>step*.52)break;}
 const nx=(x-103.5)/5,ny=(y-153.5)/2.9;
 const nose= (nx*nx+ny*ny<=1)?Math.min(5*(1-Math.abs(nx)),2.9*(1-Math.abs(ny))): -1;
 return clamp(.5+Math.max(best,nose)/step);
}
function mix(a,b,t){return a.map((v,i)=>Math.round(v*(1-t)+b[i]*t));}
function gradient(t){let a,b,f;if(t<.49){a=[119,243,236];b=[89,184,252];f=t/.49;}else{a=[89,184,252];b=[173,129,249];f=(t-.49)/.51;}return mix(a,b,clamp(f));}
function colorBin(x,y){const dx=215,dy=145;const t=((x-20)*dx+(y-55)*dy)/(dx*dx+dy*dy);return Math.round(clamp(t)*47);}
function renderIndexed(n,mode){const foreground=mode==='foreground', ios=mode==='ios', round=mode==='round',scene=foreground?108:256;
 const bg=[11,23,40], palette=[[0,0,0]], alphas=[0], raw=new Uint8Array(n*(n+1));
 const backgroundIndex=[];for(let l=1;l<=4;l++){backgroundIndex.push(palette.length);palette.push(bg);alphas.push(l*64- (l===4?1:0));}
 const levels=[.2,.4,.6,.8,1];const gradientIndices=[];
 for(let c=0;c<48;c++)for(let level=0;level<5;level++){
   const cover=levels[level],gc=gradient(c/47);
   const pix=foreground?gc:mix(bg,gc,cover);
   gradientIndices.push(palette.length);palette.push(pix);alphas.push(foreground?Math.round(255*cover):255);
 }
 const step=scene/n,strokeScale=n<=32?1.55:n<=64?1.2:1;
 for(let j=0;j<n;j++){const row=j*(n+1);raw[row]=0;
 for(let i=0;i<n;i++){
   let x=(i+.5)*step,y=(j+.5)*step;
   if(foreground){x=(x-18)/.28125;y=(y-18)/.28125;}
   const coverBg=foreground?0:ios?1:clamp(.5-((round?Math.hypot(x-128,y-128)-120:roundRectSDF(x,y))/step));
   const coverMark=(coverBg<.10&&!foreground)?0:markCoverage(x,y,foreground?step/.28125:step,strokeScale);
   let idx=0;
   if(coverMark>.1){const c=colorBin(x,y),layer=Math.max(0,Math.min(4,Math.ceil(coverMark*5)-1));idx=gradientIndices[c*5+layer];}
   else if(coverBg>.10)idx=backgroundIndex[Math.max(0,Math.min(3,Math.ceil(coverBg*4)-1))];
   raw[row+1+i]=idx;
 }}
 return {raw,palette,alphas,n};
}
function int32(v){return [(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255];}
function concat(parts){let length=0;for(const p of parts)length+=p.length;const out=new Uint8Array(length);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;}
function rev(v,n){let r=0;for(let i=0;i<n;i++){r=(r<<1)|(v&1);v>>>=1;}return r;}
const LB=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258],LE=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DB=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577],DE=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
function deflate(raw){let bytes=[],bits=0,bitpos=0;
 function put(v,n){while(n--){bits|=(v&1)<<bitpos;v>>>=1;if(++bitpos===8){bytes.push(bits);bits=0;bitpos=0;}}}
 function fixed(n){if(n<=143)put(rev(48+n,8),8);else if(n<=255)put(rev(400+n-144,9),9);else if(n<=279)put(rev(n-256,7),7);else put(rev(192+n-280,8),8);}
 function mlen(len){for(let k=0;k<LB.length;k++){const max=LB[k]+(1<<LE[k])-1;if(len<=max||k===28){fixed(257+k);if(LE[k])put(len-LB[k],LE[k]);return;}}}
 function mdist(d){for(let k=0;k<DB.length;k++){const max=DB[k]+(1<<DE[k])-1;if(d<=max){put(rev(k,5),5);if(DE[k])put(d-DB[k],DE[k]);return;}}throw Error('distance too large')}
 put(1,1);put(1,2);const recent=new Int32Array(65536);recent.fill(-1);
 let i=0;while(i<raw.length){let best=0,dist=0,key=0,h=0;
   if(i+2<raw.length){key=(raw[i]<<16)|(raw[i+1]<<8)|raw[i+2];h=((key*2654435761)>>>16)&65535;const prev=recent[h];recent[h]=i;
     if(prev>=0&&i-prev<=32768&&raw[prev]===raw[i]&&raw[prev+1]===raw[i+1]&&raw[prev+2]===raw[i+2]){
      const max=Math.min(258,raw.length-i);best=3;while(best<max&&raw[prev+best]===raw[i+best])best++;dist=i-prev;
     }
   }
   if(best>=4){mlen(best);mdist(dist);for(let j=1;j<best;j++){if(i+j+2>=raw.length)break;const h2=(((raw[i+j]<<16)|(raw[i+j+1]<<8)|raw[i+j+2])*2654435761>>>16)&65535;recent[h2]=i+j;}i+=best;}
   else{fixed(raw[i]);i++;}
 }
 fixed(256);if(bitpos)bytes.push(bits);
 let a=1,b=0;for(const v of raw){a=(a+v)%65521;b=(b+a)%65521;}
 return concat([new Uint8Array([0x78,0x01]),new Uint8Array(bytes),new Uint8Array(int32((b<<16)|a))]);
}
const crctable=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?(0xEDB88320^(c>>>1)):(c>>>1);crctable[i]=c>>>0;}
function crc(bytes){let c=0xFFFFFFFF;for(const b of bytes)c=crctable[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function chunk(name,data){const type=new Uint8Array([...name].map(v=>v.charCodeAt(0)));return concat([new Uint8Array(int32(data.length)),type,data,new Uint8Array(int32(crc(concat([type,data]))))]);}
function png(n,mode){
 const {raw,palette,alphas}=renderIndexed(n,mode);
 const rgb=mode==='ios',channels=rgb?3:4;
 const pixels=new Uint8Array(n*(n*channels+1));
 for(let j=0;j<n;j++)for(let i=0;i<n;i++){
  const index=raw[j*(n+1)+i+1],src=palette[index],at=j*(n*channels+1)+1+i*channels;
  pixels[at]=src[0];pixels[at+1]=src[1];pixels[at+2]=src[2];
  if(!rgb)pixels[at+3]=alphas[index];
 }
 const header=new Uint8Array([...int32(n),...int32(n),8,rgb?2:6,0,0,0]);
 return concat([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflate(pixels)),chunk('IEND',new Uint8Array())]);
}
function ico(icons){const frames=icons.map(([n,bin])=>({n,bin})),offset=6+16*frames.length;let at=offset,parts=[new Uint8Array([0,0,1,0,frames.length&255,frames.length>>>8])];for(const {n,bin} of frames){parts.push(new Uint8Array([n===256?0:n,n===256?0:n,0,0,1,0,32,0,...int32(bin.length).reverse(),...int32(at).reverse()]));at+=bin.length;}return concat([...parts,...frames.map(o=>o.bin)]);}
function icns(images){const records=images.map(([type,bin])=>concat([new Uint8Array([...type].map(c=>c.charCodeAt(0))),new Uint8Array(int32(bin.length+8)),bin]));const len=8+records.reduce((s,x)=>s+x.length,0);return concat([new Uint8Array([105,99,110,115,...int32(len)]),...records]);}
function b64(bytes){const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let s='';for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2];s+=abc[a>>>2]+abc[((a&3)<<4)|((b===undefined?0:b)>>>4)]+(b===undefined?'=':abc[((b&15)<<2)|((c===undefined?0:c)>>>6)])+(c===undefined?'=':abc[c&63]);}return s;}
export {png,ico,icns,b64};
