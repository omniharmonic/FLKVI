/** Bound the full-resolution HDR/AO/composer allocations even on a Retina or 4K display. */
export function budgetPixelRatio(width:number,height:number,requested:number,quality:'high'|'medium'|'low') {
  const pixels=quality==='high'?2_400_000:quality==='medium'?1_600_000:1_000_000;
  return Math.min(requested,Math.sqrt(pixels/Math.max(1,width*height)));
}

/** Small, bounded controller. Single streaming hitches must not permanently lower image quality. */
export class AdaptiveResolution {
  scale = 1;
  private samples:number[]=[];
  private elapsed=0;
  private cooldown=8;
  private fastWindows=0;
  reset(){this.scale=1;this.samples.length=0;this.elapsed=0;this.cooldown=8;this.fastWindows=0;}
  sample(seconds:number):boolean {
    if(!Number.isFinite(seconds)||seconds<=0||seconds>.25)return false;
    if(this.cooldown>0){this.cooldown-=seconds;return false;}
    this.samples.push(seconds);this.elapsed+=seconds;
    if(this.elapsed<2||this.samples.length<30)return false;
    this.samples.sort((a,b)=>a-b);
    const median=this.samples[this.samples.length>>1];
    this.samples.length=0;this.elapsed=0;
    let next=this.scale;
    if(median>.023){next=Math.max(.65,this.scale-.1);this.fastWindows=0;}
    else if(median<.018){if(++this.fastWindows>=4){next=Math.min(1,this.scale+.05);this.fastWindows=0;}}
    else this.fastWindows=0;
    if(Math.abs(next-this.scale)<.001)return false;
    this.scale=next;this.cooldown=4;return true;
  }
}
