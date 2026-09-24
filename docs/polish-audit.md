# Gameplay, rendering, and performance audit

September 24, 2026. This pass includes implementation and browser verification, not just recommendations.

## Findings and repairs

| Area | Root cause | Change |
| --- | --- | --- |
| Backwards pedestrians and officers | Character models face +Z, while movement and animation assume −Z. | Corrected the character asset rotation at the shared factory. |
| Unreliable crouch and jump | Render-frame key edges were reused across physics steps or discarded before a physics step. | Added a physics input queue consumed once per fixed step; reset held inputs on focus loss and disabled controls. |
| Crouching through ceilings | Crouch changed presentation without changing the collision capsule. | Resize the capsule while preserving foot position; check clearance before standing. Corrected the head-impact velocity test. |
| Missing road and bridge collisions | Several rendered road surfaces never received physics colliders. | Added road, path, gravel, deck, and bridge-rail collision surfaces; use world transforms and internal-edge fixing for mesh colliders. |
| Feet disagreeing with paths | The analytical ground sampler omitted the rendered surface lift. | Register the actual path surface height, including elevated footbridges. |
| Camera clipping | A center ray cannot protect the camera's width at walls and corners. | Use sphere casts for camera distance and shoulder offset. |
| Stretched concrete | Sidewalk corner triangles used a constant V texture coordinate. | Generate planar UVs for corner surfaces. |
| Over-dark colors and heavy effects | Some colors were converted from sRGB twice; AO, grain, and vignette obscured detail. | Correct color conversion, reduce those effects, and add a small daytime hemisphere fill. |
| Unnecessary traffic rendering | Distant traffic instances were submitted outside the camera view and live shadow casters had no distance limit. | Cull distant traffic against the view frustum, bound live shadow distance, and clear impact history when bodies are retired. |
| Quality settings only partly working | Building detail captured the initial tier; resolution had two competing owners. | Centralize resolution in the renderer; update building, tree, pedestrian, and vehicle detail as quality changes. Refresh parked batches when quality changes. |
| Shadow and photo-mode artifacts | Tree shadow impostors disappeared outside the camera view; paused photo mode did not refresh moving-view traffic batches. | Retain nearby offscreen tree shadows and refresh car visibility while moving the photo camera. |
| Persistently slow startup | Automatic quality selection could wait indefinitely for a hitch-free interval. | Bound the initial measurement warmup while excluding long suspension gaps. |

The physics engine itself was operational: the baseline vehicle had four-wheel suspension contact, acceleration, reverse, and steering. The most concrete failures were in input timing, collision coverage, and character/camera integration. Rapier now receives an explicit fixed timestep, and the loop preserves its fractional accumulator when limiting catch-up work. Vehicle wheel queries also exclude sensors.

## Verification

- Production TypeScript check and Vite build passed.
- Existing AI simulation suite: **35 passed**.
- Added gameplay browser regressions: **32 passed**. These exercise actual keyboard events, the game loop, Rapier bodies, and generated geometry: locomotion, queued jump/crouch, low-ceiling clearance, wall and camera collision, vehicle suspension/driving/braking/exiting, bridges, transformed colliders, sidewalk UVs, and character orientation.
- Full-city integration: **17 passed in San Francisco and 17 passed in Boulder**, including resolution/composer agreement through quality changes while paused, day/night rendering, reduced traffic submissions, and reaching and disabling a surveillance camera through hold-to-act input with scoring.
- These tests do not establish that every recipe, browser, or device works correctly.
- Browser errors were empty in the final San Francisco and Boulder runs. Daytime screenshots were inspected, including the repaired sidewalk corners.

Run `npm run test:ai`. With the shared development server running on port 5200, run `npm run test:browser` and `npm run test:world -- sf-mission`. Browser scripts require `agent-browser` and use the repository's single-browser lock. They alter a disposable test session.

## Performance evidence

Real Apple M4 GPU, Chromium, 1440 × 900 viewport, device pixel ratio 1. The following comparison freezes the same San Francisco scene and camera, samples 120 frames per case, and reconstructs the previous traffic submission behavior by disabling traffic culling and restoring unrestricted live vehicle shadow submissions. Other fixes remain enabled in both samples.

| Frozen scene | Draw submissions | Triangle submissions per frame | Mean measured CPU frame work |
| --- | ---: | ---: | ---: |
| Previous traffic submission behavior | 755 | 4,183,443 | 4.96 ms |
| Current traffic culling and shadow limits | 741 | 3,978,955 | 4.85 ms |

This removes **204,488 submitted triangles per frame (4.9%)** in this view. Three.js counters include render passes and shadow work; they are not unique mesh triangle counts. CPU differences are small and subject to noise. No GPU timestamp benchmark was collected, and the desktop tests were refresh-rate limited, so these results do not establish a universal FPS improvement.

In the same view, switching to medium submitted 3,662,294 triangles and low submitted 2,949,123. Runtime quality changes now reduce scene detail as well as resolution and effects.

## Priorities identified after the initial pass

The subsequent [world expansion and simulation upgrade](world-expansion.md) implements district streaming, fixed-rate AI, near-player obstacle sweeps, vehicle damage/handling, weather and additional animation work. The list below records the initial audit; see the expansion notes for current limitations.

1. **Collision-aware pedestrian movement.** Pedestrians still use analytical path following and separation rather than a complete obstacle-aware navigation system. The facing error is fixed, but crowded sidewalks and props need a dedicated near-player avoidance pass. Add deterministic crowd/obstacle scenarios before changing that system.
2. **Fixed-rate AI motion with interpolated presentation.** AI updates run on render frames while vehicle physics runs on fixed steps. At low frame rates, large target changes can be applied unevenly across catch-up steps. Move authoritative motion to fixed simulation timing, then interpolate visuals and test collisions under deliberately slow rendering.
3. **Reduce city construction and residency costs.** Compilation already uses a worker, but substantial geometry assembly and asset residency remain on the main thread/in memory. Profile startup phases and retained memory, then move mesh-buffer generation off-thread and stream neighborhoods. This should be measured separately from steady-state FPS.
4. **Continue reducing shadow and geometry submissions.** The tested scene still submits millions of triangles per frame. Use GPU timings to distinguish shadow, canopy/facade geometry, and postprocessing costs before the next optimization. Existing instancing and batching should be extended selectively rather than replaced wholesale.
5. **Art and long-session validation.** Correct UVs, color handling, and lighting help the current assets; they do not replace an art-direction and asset-detail pass. Context restoration, repeated city changes, and sustained memory behavior also need dedicated testing, especially because static geometry CPU arrays are released after upload.

These are follow-up architectural tasks, not claims of additional verified failures. The implemented changes address the reproducible defects covered above without adding dependencies.
