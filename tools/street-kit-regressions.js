// Disposable asset inspection: verifies CC0 offline assemblies and stages them for a screenshot.
(async () => {
  const g = game;
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { prepareStreetKit, streetKitParts } = await import('/src/assets/street-kit.ts');
  await prepareStreetKit();
  g.paused = true;
  const checks = [], check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  const root = new THREE.Group();
  root.name = 'street-kit-inspection';
  const y = g.player.position.y + 8;
  root.position.set(g.player.position.x, y, g.player.position.z);
  const materialBank = {};
  const expected = { hydrant: { min: [0.2, 0.7, 0.25], max: [0.5, 0.9, 0.5], tris: 2000, x: -1.9 }, trash: { min: [0.5, 0.8, 0.5], max: [0.8, 1.1, 0.8], tris: 1800, x: 2 }, bench: { min: [1.8, 0.7, 0.5], max: [2.2, 1, 0.8], tris: 3000, x: 0 } };
  for (const id of ['hydrant', 'bench', 'trash']) {
    const parts = streetKitParts(id, materialBank);
    check(`${id} loads the scanned PBR kit`, parts?.length > 0);
    if (!parts) continue;
    const item = new THREE.Group();
    let triangles = 0, valid = true, pbr = true;
    for (const part of parts) {
      triangles += part.geo.index.count / 3;
      const mesh = new THREE.Mesh(part.geo, materialBank[part.mat]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      item.add(mesh);
      pbr &&= !!mesh.material.map && !!mesh.material.normalMap && !!mesh.material.roughnessMap;
      const count = part.geo.attributes.position.count;
      valid &&= [...part.geo.index.array].every(i => i >= 0 && i < count);
    }
    const box = new THREE.Box3().setFromObject(item), size = box.getSize(new THREE.Vector3()).toArray(), spec = expected[id];
    check(`${id} is one complete correctly scaled assembly`, size.every((n,i) => n >= spec.min[i] && n <= spec.max[i]) && box.min.y >= -0.002, size);
    check(`${id} has PBR maps and a bounded valid mesh`, pbr && valid && triangles <= spec.tris, { triangles, pbr, valid });
    item.position.x = spec.x; root.add(item);
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(9, 0.12, 6), new THREE.MeshStandardMaterial({ color: '#656362', roughness: 0.88 }));
  floor.position.y = -0.065; floor.receiveShadow = true; root.add(floor);
  g.scene.add(root);
  g.camera.position.set(root.position.x + 3.7, y + 2.6, root.position.z + 7.2);
  g.camera.lookAt(root.position.x, y + 0.55, root.position.z);
  g.camera.fov = 42; g.camera.updateProjectionMatrix();
  await g.renderer.compileAsync(root, g.camera, g.scene);
  g.renderFrame(1 / 60);
  const failed = checks.filter(c => !c.pass);
  window.__streetKitResults = { passed: checks.length - failed.length, failed: failed.length, checks };
  console.log(JSON.stringify(window.__streetKitResults));
  if (failed.length) throw new Error(failed.map(c => c.name).join(', '));
  return window.__streetKitResults;
})();
