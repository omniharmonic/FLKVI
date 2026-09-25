(() => {
const g=game,p=g.player.position,b=g.recipe.bounds;
const generated=g.recipe.attribution.some(a=>a.startsWith('Generated world'));
const expected=new URLSearchParams(location.search).get('expect');
if(generated!==(expected==='generated'))throw Error(`Unexpected geography: ${g.recipe.name}`);
if(!Number.isFinite(p.y)||p.x<b.minX||p.x>b.maxX||p.z<b.minZ||p.z>b.maxZ)throw Error('Invalid player position');
const gap=Math.abs(p.y-g.world.groundAt(p.x,p.z));if(gap>1.5)throw Error(`Player not grounded: ${gap}`);
if(g.renderer.info.programs.some(p=>p.diagnostics?.runnable===false))throw Error('Shader compilation failed');
if(generated&&!document.body.textContent.includes('GENERATED WORLD'))throw Error('Missing generated-world label');
if(!g.recipe.roads.length||!g.recipe.cameras.length)throw Error('Missing playable streets/objectives');
return {name:g.recipe.name,generated,readyMs:Math.round(performance.now()),gap,roads:g.recipe.roads.length,buildings:g.recipe.buildings.length,store:window.__worldStore};
})()
