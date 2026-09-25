# FLK VI: asset and stability overhaul, September 25

Tagline: **Take the city back, one camera at a time.**

## What changed

### Streaming and long sessions

District loading now has a bounded live-map worker deadline. When bundled/cached maps and the live service cannot supply a district, deterministic generated outskirts continue resident road approaches and terrain. The game labels these as generated: they are approximate landscapes, not additional surveyed streets. Requests are serialized, generated recipes have an eight-entry cache, and resident district resources are retired as the player travels.

Roads and land-cover polygons are clipped before geometry generation. Shader preparation has a deadline and context-loss handling. Ground-cover indices are cached per recipe, avoiding repeated reconstruction of the initial city. A district's facades are visible on its first frame; unavailable detailed building meshes preserve the complete distant facade.

Road-network merging uses world coordinates rather than confusing source-local IDs with graph indices. Idle pedestrians now invalidate references into retired sidewalk networks before resuming movement. Patrols and responders can spawn along rural lane interiors. Repair crews and escalation cameras retire with their districts; escalation chooses locations from the current resident network.

### Assets and rendering

- Five CC0 scanned terrain sets: forest floor, alpine rock, red desert sand, coastal sand and snow. Biome-specific sets load only where needed.
- Three assembled and simplified Poly Haven street props: hydrant, trash bin and bench. Their combined geometry is 6,396 triangles and approximately 260 KB of GLBs; instancing and shared textures preserve bounded rendering costs. Procedural fallbacks remain available when assets fail.
- Buildings now actually sample their scanned normal maps. The previous shader substitution missed Three.js's unexpanded shader chunk and sampled a flat dummy texture instead. Real roughness and cavity maps share the alpha channels of the existing texture arrays, avoiding extra arrays and draw calls.
- Eighty-four offline-prepared facade maps match the existing 512-pixel array resolution, avoiding decoding much larger source images during startup.
- Adaptive rendering resolution responds to sustained frame pressure within a bounded range and respects the user's quality/resolution settings. An isolated streaming hitch does not lower image quality.
- Recovery controls store a local diagnostic report and offer a copy button with a selectable-text fallback.

Asset sources and licenses are recorded in `public/assets/LICENSES.json`. `tools/build-street-kit.mjs` and `src/assets/fetch/build-facade-maps.mjs` reproduce the optimized derivatives.

### Walking, impacts and animation

Sidewalk/curb collision triangles are joined before internal-edge correction. Retaining-wall terrain uses the actual displaced triangles where a regular heightfield would create an invisible ramp. Ground queries follow those same displaced surfaces.

Incoming traffic becomes dynamic before striking a stationary player vehicle. Ground-support contacts no longer count as side impacts; legitimate impact rotation survives steering assistance briefly. Damage affects attached trim and individual lamps, with bounded chassis recoil, and damaged cars retain their own geometry at distance. Static collision bounds accelerate clearance checks without scanning every terrain triangle.

The grinder enters its kneeling pose once, cycles within the working portion of the clip, and plays the standing exit when released.

## Verification and limits

Tests run through the repository's serialized browser wrapper on Apple M4/ANGLE Metal. This is evidence for this browser and machine, not universal performance or browser compatibility. The game remains an evolving browser game; this release does not achieve GTA IV asset, animation or physics parity. Player ragdolls, detachable vehicle panels, higher-fidelity character models and extensive authored environment assets remain substantial future work.

A combined render/AI soak exposed a separate severe hitch: each district added sixteen real spotlights, changing the shader light count for the whole scene. The initial world's permanent sixteen-light pool now selects lamp positions across all resident districts. Drone searchlights likewise use three permanent slots through spawn, impact, retirement and reset. Unused lights stay visible with zero intensity, keeping the shader light count constant.

The initial eleven-transition stress run reached six generated rings and returned, without runtime errors, but recorded a **17,499 ms** worst frame. After the fixed light pools, an instrumented seven-transition repeat (rings 1–4 and back) measured **16.7 / 16.7 / 16.8 ms median / p95 / p99**, **233.3 ms worst**, and three frames above 100 ms. All seven sampled positions had loaded collision; sampled JS heap was **317–426 MB**. Rendering, traffic, pedestrians and alternating rain/clear weather remained active, with no runtime errors or failed shader programs. This test teleports between resident roads to stress streaming and retirement; it is not continuous driving. Brief construction hitches remain.

Visual checks booted Frisco (alpine), Moab (desert), Russell (plains), and Greenwich Village (urban) with valid ground and no shader errors. These were sequential navigations, so heap readings from that check should not be interpreted as fresh-world memory requirements.

The 75-second automatic-prefetch drive smoke test also kept full AI and pursuit active: three adjacent districts loaded, median/p95 were 16.7 ms, worst frame 216.7 ms, and no runtime/shader errors occurred. Its simple scripted steering hit a parked SUV and did not complete a road crossing; it verifies stability under traffic/contact/pursuit, not successful navigation. Separate solver-driven real-road and generated-seam checks verified crossings.

Passing regression groups: 48 district/combat/weather/damage checks; 32 gameplay checks; 17 world/render/input checks; 47 AI simulation checks; 10 data checks; 14 continuation/compiler/render-budget checks; 16 extended streaming checks; 11 streamed-AI/grinder/retirement checks; 16 standing-pose ragdoll variants; 3 facade LOD checks; 9 assembled-asset checks; 7 streetlight-pool checks; 4 drone-light lifecycle checks; 3 surveillance retirement checks. The physics-focused pass additionally covered 40 curb traversals and 28 collision/sidewalk/vehicle-lifecycle assertions. The ragdoll integration fixture was corrected to evaluate a standing pose and measure from actual impact creation; its original motion thresholds were retained.

Typecheck, the Pages production build, whitespace validation, and license coverage (819 files, 101 entries) pass. `npm run test:soak` repeats the active render/AI retirement stress; `npm run test:streaming:extended` repeats blocked-map-service continuation and a physical seam crossing. CI now runs the pure stability regressions and license audit on deployment.
