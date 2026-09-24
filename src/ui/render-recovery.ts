import type { Game } from '../core/game';
import { h, uiRoot } from './dom';
/** GPU resources discard CPU copies after upload. A lost context requires rebuilding the world. */
export function installRenderRecovery(g:Game):()=>boolean {
  let lost=false;
  const show=(runtimeMessage?:string)=>{
    if(lost)return;
    lost=true;g.paused=true;g.input.reset();g.input.enabled=false;
    document.exitPointerLock?.();
    const retry=h('button',{class:'gt-btn primary'},runtimeMessage?'Restart this location':'Restart with lighter graphics');
    retry.addEventListener('click',()=>{
      if(!runtimeMessage)try{localStorage.setItem('gt.quality','low');}catch{/* private browsing */}
      const url=new URL(location.href);if(!runtimeMessage)url.searchParams.set('quality','low');
      location.assign(url.href);
    });
    uiRoot().appendChild(h('div',{class:'gt-unsupported gt-render-recovery',role:'alertdialog','aria-modal':'true'},
      h('div',{class:'box'},h('h1',{},runtimeMessage?'FLK VI stopped unexpectedly':'The graphics device stopped responding'),
        h('p',{},runtimeMessage??'Restart this location with lighter graphics to reduce memory use.'),retry)));
    retry.focus();
  };
  g.renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();show();});
  addEventListener('flk-runtime-error',e=>show((e as CustomEvent<string>).detail));
  return ()=>lost;
}
