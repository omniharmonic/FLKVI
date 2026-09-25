import type { Game } from '../core/game';
import { h, uiRoot } from './dom';
/** GPU resources discard CPU copies after upload. A lost context requires rebuilding the world. */
export function installRenderRecovery(g:Game):()=>boolean {
  let lost=false;
  const show=(runtimeMessage?:string)=>{
    if(lost)return;
    lost=true;g.paused=true;g.input.reset();g.input.enabled=false;
    document.exitPointerLock?.();
    const report=JSON.stringify({
      time:new Date().toISOString(),location:g.recipe.name,url:location.href,
      error:runtimeMessage??'webglcontextlost',quality:g.quality,
      position:g.player?{x:g.player.position.x,y:g.player.position.y,z:g.player.position.z}:null,
      graphics:g.renderer.info.memory,drawCalls:g.renderer.info.render.calls,
      browser:navigator.userAgent,
    },null,2);
    try{localStorage.setItem('flk.lastCrash',report);}catch{/* Storage can be unavailable. */}
    const retry=h('button',{class:'gt-btn primary'},runtimeMessage?'Restart this location':'Restart with lighter graphics');
    retry.addEventListener('click',()=>{
      if(!runtimeMessage)try{localStorage.setItem('gt.quality','low');}catch{/* private browsing */}
      const url=new URL(location.href);if(!runtimeMessage)url.searchParams.set('quality','low');
      location.replace(url.href);
    });
    const copy=h('button',{class:'gt-btn'},'Copy error report');
    copy.addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText(report);copy.textContent='Report copied';}
      catch{const text=h('textarea',{'aria-label':'Error report',readonly:true},report);copy.after(text);text.select();}
    });
    uiRoot().appendChild(h('div',{class:'gt-unsupported gt-render-recovery',role:'alertdialog','aria-modal':'true'},
      h('div',{class:'box'},h('h1',{},runtimeMessage?'FLK VI stopped unexpectedly':'The graphics device stopped responding'),
        h('p',{},runtimeMessage??'Restart this location with lighter graphics to reduce memory use.'),retry,copy)));
    retry.focus();
  };
  g.renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();show();});
  addEventListener('flk-runtime-error',e=>show((e as CustomEvent<string>).detail));
  return ()=>lost;
}
