/** Bound the full-resolution HDR/AO/composer allocations even on a Retina or 4K display. */
export function budgetPixelRatio(width:number,height:number,requested:number,quality:'high'|'medium'|'low') {
  const pixels=quality==='high'?2_400_000:quality==='medium'?1_600_000:1_000_000;
  return Math.min(requested,Math.sqrt(pixels/Math.max(1,width*height)));
}
