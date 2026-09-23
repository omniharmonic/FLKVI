// OWNER: assets agent. Generates procedural CC0 masks (puddle, oil, lens dirt) as PGM; see gen_decals notes in fetch/README comments.
// Usage: node gen-noise-masks.mjs <outDir>  then ffmpeg -i x.pgm -q:v 3 x.jpg into public/assets/textures/decal-*/opacity.jpg and fx/lens-dirt.jpg
import fs from 'node:fs';
function mulberry(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
function makeNoise(seed){const r=mulberry(seed);const P=256;const g=new Float32Array(P*P).map(()=>r());
  const v=(x,y)=>{const xi=Math.floor(x),yi=Math.floor(y),fx=x-xi,fy=y-yi;const s=t=>t*t*(3-2*t);const G=(i,j)=>g[((j&255)*P)+(i&255)];
  const a=G(xi,yi),b=G(xi+1,yi),c=G(xi,yi+1),d=G(xi+1,yi+1);const u=s(fx),w=s(fy);return a+(b-a)*u+(c-a)*w+(a-b-c+d)*u*w;};
  return (x,y,oct=5)=>{let s=0,amp=0.5,f=1;for(let o=0;o<oct;o++){s+=amp*v(x*f,y*f);f*=2;amp*=0.5;}return s/(1-Math.pow(0.5,oct));};}
function write(name,w,h,fn){const b=Buffer.alloc(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)b[y*w+x]=Math.max(0,Math.min(255,Math.round(fn(x,y)*255)));
  fs.writeFileSync(name,Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`),b]));}
const out=process.argv[2];
const n1=makeNoise(1),n2=makeNoise(2),n3=makeNoise(3),n4=makeNoise(4);
const ss=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
// puddle: irregular edge, fully opaque interior
write(out+'/puddle.pgm',512,512,(x,y)=>{const dx=(x-256)/256,dy=(y-256)/256;const r=Math.hypot(dx*1.1,dy);const n=n1(x/90,y/90);return ss(0.08,0.0,r+ (n-0.5)*0.9-0.55);});
// oil: soft mottled stain
write(out+'/oil.pgm',512,512,(x,y)=>{const dx=(x-256)/256,dy=(y-256)/256;const r=Math.hypot(dx,dy*1.3);const n=n2(x/60,y/60);return ss(0.9,0.2,r+(n-0.5)*0.7)*(0.55+0.45*n3(x/20,y/20));});
// lens dirt: soft smudges + a few specks, mostly dark
write(out+'/lensdirt.pgm',1024,576,(x,y)=>{const a=n4(x/220,y/220);const b=n2(x/40+9,y/40+3);let v=Math.pow(ss(0.45,0.8,a),1.5)*0.55+Math.pow(ss(0.6,0.9,b),2)*0.25;return v;});
