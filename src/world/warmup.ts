import type { WebGLRenderer } from 'three';
/** Shader readiness cannot strand the only district build slot after a GPU/context failure. */
export function boundedWarmup<T>(work:Promise<T>,renderer:WebGLRenderer,timeoutMs=8000):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    const canvas=renderer.domElement;
    const lost=()=>finish(new Error('Graphics context lost during district warm-up'));
    const timer=setTimeout(()=>finish(new Error('District shader preparation timed out')),timeoutMs);
    const cleanup=()=>{clearTimeout(timer);canvas.removeEventListener('webglcontextlost',lost);};
    let settled=false;
    const finish=(error?:unknown,value?:T)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(value as T);};
    canvas.addEventListener('webglcontextlost',lost,{once:true});
    if(renderer.getContext().isContextLost())lost();
    work.then(value=>finish(undefined,value),error=>finish(error));
  });
}
