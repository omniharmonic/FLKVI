# FLK VI: district reliability and physical impacts

The tagline is **Take the city back, one camera at a time.** GTA IV is the reference, not an achieved fidelity or performance claim.

## World loading

- All 16 featured locations include a lazily downloaded expansion source covering the first eight neighboring districts. The initial download does not fetch these 83 MB of nationwide packs: only the selected location's pack is requested as the player approaches its edge. More distant and custom locations still use live map services and the bounded district cache.
- The initial terrain and collision now end at the recipe's road boundary. Previously the 60 m DEM sampling margin became playable terrain, leaving a roadless strip before the next district began.
- Districts share paving materials with the initial streets. Terrain seams, safety barriers, graph refresh and collision attachment remain coordinated.
- A persistent HUD status reports loading and retrying. Public map service failures retain the safety boundary.
- Three new starts: Frisco, Colorado (alpine); Russell, Kansas (plains); Lakewood, Colorado (suburban). Geography comes from OSM and terrain tiles; building facades remain procedural.

## Physics and animation

- Traffic becomes dynamic before an impending collision, preserving its incoming velocity. Previously its first contact behaved like an infinite-mass obstacle.
- A minimal additive `System.afterPhysics` hook measures actual solver velocity changes after each fixed step. Damage requires a contact and uses the strongest contact's location; engine/brake/suspension impulses do not count as crashes. Each vehicle receives its own damage once.
- Reduced restitution and removal of artificial upward impact boosts keep collision response grounded. Undriven cars retain legitimate rolls and roof landings.
- Dents modify only the affected vehicle's body geometry; damaged glass gains local cracks. Damage affects alignment, engine condition and hazards.
- Nearby civilians and officers can enter an 11-body articulated ragdoll with constrained knees/elbows, impact momentum and collision, then blend back to getting up. Simulation is capped at four ragdolls (two on low); other impacts use authored animations. Ragdoll bodies are removed on recovery and pooling. This does not add a player ragdoll or GTA's full animation system.
- Abandoned damaged parked cars beyond 180 m retire after 45 seconds without damage, freeing the nearby physics pool; their old slot does not regenerate a pristine replacement. Nearby and occupied vehicles retain their condition.

## Rendering and resilience

- Physical render targets are capped at 2.4 million pixels on high, 1.6 million on medium and 1 million on low, including high-density displays. Smaller requested resolutions remain respected.
- Additional resident districts are limited to three (two on low), except when occupied/adjacent terrain needs protection. Their tree atlases use half-sized tiles without multisampling. District road/terrain CPU geometry is released after collision creation and GPU upload; owned material/atlas resources are disposed on eviction.
- District building generation yields in shorter work slices, and new shader variants compile asynchronously before attachment. Nonurgent prefetched districts are spaced apart. Regional ground cover uses bounded nearby instancing, opaque wind-animated blades and rocks, with distinct desert, alpine and plains palettes. Alpine terrain and distant peaks receive elevation/slope snow coverage.
- A lost graphics context pauses rendering and offers a restart with lighter settings. Static GPU data discards CPU copies, so restoration requires rebuilding the world. A runtime exception stops the animation loop after one report and shows a restart control; it no longer floods every subsequent frame with the same exception.

## Verification

- 48 district/combat/animation/weather/deformation integration checks passed.
- 8 real solver collision checks passed, including a 22 m/s wall impact.
- An isolated real Grove Street crossing retained 100% vehicle health with no impacts; sampled road heights differed by about 3 cm at the seam.
- 32 gameplay checks and 35 AI simulation checks passed.
- 17 full-city checks passed, including day/night rendering, quality/resolution changes and a scored camera takedown.
- 10 pure/data checks passed, including coverage and graph validity for all 16 bundled expansion packs.
- All 16 featured starts booted with the player grounded and no browser errors. A fresh New York load measured about 497 MB of JavaScript heap; sequential navigation readings were substantially higher and are not representative of a fresh single world.
- Runtime-error and graphics-context-loss injection both showed responsive recovery controls. Restarting after context loss returned to the same city on low quality.
- Type checking, the GitHub Pages production build and third-party asset license coverage passed (706 asset files / 92 entries).

A final 80-second Boulder session at 1440 × 900 on high quality drove from Grove Street across the original boundary, with traffic and weather changes, while public map requests were blocked. The bundled district loaded in **1.37 seconds**. Median and 95th-percentile frame times were **16.7 / 16.8 ms**; the worst frame was **1067 ms**, so streaming is still not hitch-free. Sampled JavaScript heap ranged from **428 to 546 MB**. No browser errors were reported; intentionally blocked requests beyond bundled coverage entered retry handling and retained their boundary.

An earlier test of the inefficient construction path stalled for many seconds while assembling additional districts. Filtering roads before construction, early triangle rejection, smaller district resources and asynchronous shader preparation materially reduced those stalls. These measurements do not establish performance on other devices. Tests use one Chromium instance on Apple M4 through `tools/browser.sh`. Synthetic physics checks complement real map crossings; neither establishes compatibility with every GPU/browser.

## Remaining limits

Photoreal character/vehicle assets, comprehensive authored animation, detachable body panels, player ragdolls, arbitrary bridge seam reconstruction and broader browser/GPU testing remain substantial work. Bundled coverage removes live map dependence for the first ring, not for unlimited travel. No claim of GTA IV parity, universal 60 FPS, or complete elimination of every reported crash is made.

The loading audit also found unnecessary full-source road assembly and an unbounded spread append for mesh buffers. District road selection now retains only nearby ways (plus a junction margin), triangle clipping rejects wholly outside geometry early, and large mesh appends avoid JavaScript's function-argument limit. Regression coverage includes a batch above that limit.
