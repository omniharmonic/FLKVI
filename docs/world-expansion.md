> Historical first expansion pass. See [the FLK VI stability release](flk-vi-stability.md) for current ragdolls, bundled map coverage, boundary fixes and limits.

# World expansion and simulation upgrade

September 24, 2026. Implemented locally; publication is separate.

## What changed

### Explore beyond the original square

The browser now compiles neighboring districts as the player approaches the loaded boundary. This works on static hosting: the existing compiler worker fetches public OpenStreetMap and elevation data, and the client builds the new scene and colliders.

- New districts extend the original rectangle in 400 m increments. Each district shares the original coordinate frame and elevation datum; boundary terrain is feathered to meet loaded neighbors.
- Prefetch starts within 380 m and favors the direction of travel. Only one fetch/build runs at a time.
- A physical boundary stays in place until the next district has terrain and collision. Slow or unavailable map data produces a loading/retry message instead of allowing the player to fall off the map.
- Five additional districts can remain resident alongside the initial city. Distant districts release geometry, material clones, tree buffers and physics bodies. An occupied district is protected from eviction.
- Up to twelve compiled district recipes are cached locally. Failed requests retry with backoff.
- Traffic, pedestrian routes, police junction references, surveillance cameras and the minimap incorporate resident districts. Traffic refresh preserves existing vehicle poses and modes.

This is streaming with network-dependent loading, not a guarantee of uninterrupted high-speed travel. Public map servers can take minutes. Initial city geometry remains resident; there is no floating-origin implementation or nationwide endurance test yet.

### Rural terrain and three more featured places

Compilation no longer requires a drivable city road. Trails and suitable dry, level ground provide fallback spawn candidates; unsafe locations can still fail rather than placing the player in water or a building.

| New featured place | Buildings | Roads | Trees |
| --- | ---: | ---: | ---: |
| Denver, LoDo | 1,528 | 1,268 | 3,673 |
| Santa Fe | 1,045 | 1,021 | 1,936 |
| Moab | 449 | 230 | 2,108 |

All three have baked recipes and picker thumbnails. Their geography uses real map data; facades and street assets are generated, not individually surveyed or photogrammetric models.

### Driving, collisions and fighting

- Vehicle suspension now applies axle anti-roll forces based on suspension travel, with Ackermann steering and reduced artificial drift assistance.
- Rain reduces tire grip and adds spray. Damage reduces engine output, affects alignment, deforms a car's own body mesh and adds localized paint scuffs. Damaged cars retain their condition when parked. The HUD shows gear and condition.
- Overturned cars remain overturned until deliberately recovered with **R**.
- **G**, or left click with mouse capture, starts a punch. Hits select a nearby target in front, require clear line of sight, and affect civilians and officers. An officer knocked down cannot continue an arrest while stunned.
- Jump start, landing, impact, entry/exit, falling and getting up use animation transitions. Pedestrians and officers share the corrected facing direction.
- Authoritative AI motion runs at the fixed simulation rate before vehicle updates. Near-player pedestrians sweep against solid walls and props.

These changes do not implement articulated physical ragdolls, detachable body panels or GTA IV's full damage/animation system.

### Rendering, characters and weather

Close characters use the full source geometry for faces, hands, clothing and hair, with physical cloth shading; cheaper detail levels remain farther away. This improves the existing Quaternius characters rather than replacing them with scanned humans.

Weather now has clear, overcast, rain, storm and fog states, with gradual automatic changes, settings buttons and **F7** cycling. Rain samples roof/ground coverage, places splash particles on surfaces and drives wet-road/tire effects. A manual weather choice disables automatic weather changes.

The earlier UV, color-space, lighting, shadow, culling and quality-setting improvements remain in place. No new third-party asset dependencies were added.

## Verification

- **36 browser integration checks passed:** district attachment and eviction, collider ownership, boundary protection, terrain seams, driving across the original edge, AI pose preservation, punches and occlusion, officer knockdown, animation transitions, vehicle deformation and wet grip, all five weather shaders and rain coverage.
- **5 compiler/coordinate checks passed:** positive/negative tile boundaries, coordinate/elevation rebasing, graph identity/deduplication, unloaded graph filtering and roadless rural compilation.
- **35 AI simulation checks and 32 gameplay browser checks passed.**
- **17 full-city checks passed in Moab**, including scoring a camera takedown, day/night rendering and runtime quality changes. Denver and Santa Fe also booted with the player grounded and no browser errors.
- The production build passed with `BASE=/groundtruth/`, along with type checking and asset license coverage.
- A separate live-data test loaded the district east of Boulder: **518 buildings, 863 roads and 857 trees**. Five sampled terrain heights around and beyond the original edge matched Rapier ray hits. The minimap displayed the extension and the browser reported no errors.

Run `npm run test:deep` for pure checks. With the shared server on port 5200, run `npm run test:integration` for disposable browser fixtures. Add `&nostream` to a debug URL to disable automatic map requests during deterministic tests; normal play streams automatically.

## Remaining production work

GTA IV remains a reference target, not an achieved quality claim. The largest gaps are art assets and authored animation coverage, physical ragdolls, off-thread geometry assembly, seamless road/bridge reconstruction across arbitrary district boundaries, and long-session memory/performance validation across browsers and GPUs. Terrain seam and synthetic driving tests do not establish every real road crossing is smooth. A frozen Moab comparison submitted 1,424,487 triangles with traffic culling versus 1,615,411 with the previous submission behavior (11.8% fewer); mean measured CPU frame work was 4.28 ms versus 4.37 ms, a small difference subject to noise. This used Chromium on Apple M4 at 1440 × 900 and counts all render passes. The additional detail and weather also need GPU profiling; no universal FPS gain is claimed for this expansion.
