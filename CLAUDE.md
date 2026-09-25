# Groundtruth — build brief for agents

Browser open-world game: pick a real US location, play a photoreal 3D version of it compiled from open data, take down surveillance cameras, build the longest streak without getting caught. Full design docs: `flk_docs/01..05`. **Read `flk_docs/05-Game-Design-Surveillance-Takedown.md` and the parts of `02-Technical-Architecture.md` relevant to your area.**

## Session-scale adaptation of the plan
The docs describe a 10-month nationwide pipeline. In this build:
- **Normal gameplay uses hosted geographic packages**, never Overpass. `world-store.worker.ts` handles startup and travel with bounded fetch/decode/cache; `public/world/index.json` describes coverage. Outside coverage, visibly labeled generated geography continues play. `tools/bulk-import-world.ts` imports regional OSM offline; `tools/bake-world.ts` publishes hashed 400 m chunks. The old live compiler remains a developer tool only. Terrain source: cached AWS Terrain Tiles (Terrarium). See `docs/hosted-world.md` and `docs/offline-world-import.md`.
- Assets are **CC0** (Poly Haven, ambientCG, Kenney, Quaternius) or procedurally generated in code. Every downloaded asset gets an entry in `public/assets/LICENSES.json`. No real brands, no real police insignia.
- Renderer: Three.js `WebGLRenderer` + `postprocessing` (pmndrs) + `n8ao`. Physics: Rapier (`@dimforge/rapier3d-compat`, already initialized; world at `g.physics`). Trees: `@dgreenheck/ez-tree` is installed.
- Deployed free on GitHub Pages (repo `omniharmonic/FLKVI`). **Asset URLs must be built from `import.meta.env.BASE_URL`** (e.g. `` `${import.meta.env.BASE_URL}assets/textures/...` ``), never absolute `/assets/...`.

## Quality bar
**Photorealism is the goal.** Grounded realism: PBR materials with real textures, correct real-world scale (meters), believable wear, soft shadows, AO, atmospheric haze, bloom on lights, real night with lit windows and streetlights. Vivid, dynamic, fun. Performance target: 60 fps on a discrete GPU with ~1 km² of city — use instancing/merged geometry, share materials, avoid per-object draw calls for repeated things.

## Architecture (read `src/core/*` first — it is the contract)
- `src/core/types.ts` — the **Recipe** format (compiler → client). Coordinates: meters, **+X east, +Z south (north = −Z), +Y up**, origin at spawn.
- `src/core/api.ts` — service interfaces each module publishes on the `Game` object (`g.world`, `g.player`, `g.vehicles`, `g.heat`, `g.surveillance`, `g.sky`, `g.audio`).
- `src/core/events.ts` — typed event bus (`g.events.on/emit`). Append new event types; don't rename existing ones.
- `src/core/game.ts` — `Game` context, `System` interface (fixedUpdate 60 Hz / update / lateUpdate), main loop. `g.renderFrame` is overridable by render.
- `src/main.ts` — boot order: spawn picker → loadRecipe → setupRendering → setupAudio → buildWorld → setupGameplay → setupAI → setupSurveillance → setupHUD → start.

Core files are owned by the lead. If you need a contract change, make the **minimal additive** change (new optional field / new event) and mention it in your final report.

## Ownership (edit only your directories)
| Dir | Owner | Entry point |
|---|---|---|
| `src/compiler/`, `tools/`, `public/recipes/` | compiler | `loadRecipe(loc, progress)` |
| `src/assets/`, `public/assets/` | assets | `src/assets/library.ts` |
| `src/world/` (except `buildings/`) | world | `buildWorld(g, progress)` → sets `g.world` |
| `src/world/buildings/` | buildings | `buildBuildings(...)` called by world |
| `src/render/` | render | `setupRendering(g)` → sets `g.renderer`, `g.sky`, `g.renderFrame` |
| `src/game/` | gameplay | `setupGameplay(g)` → sets `g.player`, `g.vehicles` |
| `src/ai/` | ai | `setupAI(g)` → sets `g.heat` |
| `src/surveillance/` | surveillance | `setupSurveillance(g)` → sets `g.surveillance` |
| `src/ui/`, `src/audio/` | ui+audio | spawn picker, loading, HUD, maps; `setupAudio(g)` |

Several agents work in this tree **at the same time**. Don't run `npm install` (ask the lead in your report if you need a package; everything common is installed). Don't reformat or "fix" other owners' files. Type errors in files you don't own are not yours — check your own with `npx tsc --noEmit 2>&1 | grep src/<yourdir>`.

## Testing — RESOURCE RULES (the host machine crashed once from overload; these are mandatory)
- **Do NOT start your own vite server.** One shared dev server runs at **http://127.0.0.1:5200** (the lead keeps it up; it hot-reloads everyone's edits). If it's down, tell the lead in your report rather than starting others; you may start it yourself only with `PORT=5200 npx vite --strictPort` if nothing is listening on 5200.
- **Never run `agent-browser` directly.** Always go through the lock script, which allows ONE headless Chromium machine-wide, caps a session at 240 s, and always closes the browser:
  `tools/browser.sh 'agent-browser open "http://127.0.0.1:5200/?autostart"; sleep 25; agent-browser screenshot /path/to/scratch/shot.png'`
  The lead monitors Chromium counts; a second browser is a violation. Batch what you need (several screenshots / evals) into one call, keep sessions short, and don't loop screenshotting. The test browser now uses the real GPU (Apple M4 via ANGLE/Metal), so fps and ms/frame numbers are meaningful.
- **Never** `pkill`/`killall` by name; only kill PIDs you started. No long-running background processes left behind when you finish.
- Keep your scratch scripts and screenshots in your OWN subfolder of the scratchpad (e.g. `<scratchpad>/<your-role>/`); other agents share the scratchpad and generic names like `shoot.sh` get overwritten.
- Heavy Node jobs (baking cities, texture conversion) one at a time. Prefer Boulder for browser tests (lightest city); memory on this host is tight.
- `window.game` is the Game instance for debugging (`agent-browser eval`). `?autostart` skips the menus (default Boulder); `?city=<id>` picks a baked city; `&mode=freeroam`.

## Conventions
- TypeScript strict, ES modules, no frameworks for UI (vanilla DOM + CSS).
- Deterministic randomness: `rng(seed)` / `hashString` from `src/core/geo.ts`.
- Dispose-friendly: group things under a named `THREE.Group` per module.
- Keep bundle lean: no giant dependencies.
