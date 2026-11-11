# FormulaSim Master Build Specification
Goal:
Create an interactive frontend experience centered on a 3D racing car model (F1/F2/F3/GT).

Core Element:
A high‑fidelity 3D car placed in the center of the screen with two states:
- Idle Mode (0 km/h)
- Motion Mode (speed-based animation)

Interactive Effects (user‑triggered):
- Airflow/Aerodynamics: visual air streaks + pressure zones reacting to speed.
- Rain Mode: droplets, spray, wet-surface reflections.
- Optimal Race Weather: clean lighting, track shimmer, ideal conditions.

User Controls:
- Car selection (F1/F2/F3/GT)
- Speed selection (idle → high speed)
- Environment toggles (Airflow / Rain / Optimal Weather)
- Camera modes (Orbit / Trackside / Cockpit / Drone)
- Play/Pause animation

Experience:
Cinematic, educational, interactive. 
A mini wind‑tunnel simulator showcasing physics + environment effects.


## Core Principle

Never let the rendered scene drift from selected state. Car geometry, speed-driven animation, and environment effects (Airflow / Rain / Optimal Weather / CFD) must always mirror the current user selection. Keep architecture clean and predictable. Prefer clarity over cleverness.


## Development Approach — TDD

Follow test-driven development. Write tests **before** developing features or fixing bugs.


## Lessons Learned (read before starting work)

These come from real mistakes on this project. Each one cost a round trip with the user.

### Verify what the user will see and hear, not only the numbers
- **Unit tests did not catch any of the visual bugs that reached the live site.** Screenshots did. After any change to the track, ground, scenery or effects, render it and look.
- **Look from more than one angle, and around the whole lap.** A lap test filmed only from behind missed a road that ended 35 m behind the car. Checking a few hand-picked corners missed striped ground at Bruxelles. Run `node scripts/verify-lap-sweep.mjs` (needs `npm start`) after ground or track changes; it reads pixels at every 250 m.
- **A fix can make things worse.** The first fix for the striped ground buried the road under grass on a third of the lap. Re-run the sweep after the fix, not only before.
- **A check that always passes proves nothing.** Confirm a new check fails on the broken version (a `git worktree` of the old commit on another port works well).
- **Sound cannot be judged by code or metrics.** The first engine sound passed every test and was described by the user as "a fruit fly". For any audio change: render WAV files offline (OfflineAudioContext on a blank same-origin page, not inside the 3D app), send two or three variants, and let the user choose by ear before shipping.

### This scene's quirks
- **Lighting is very bright by design** (`scene-config.js`). Mid-tone materials wash out to pastel or near-white. New grass, foliage and buildings need much darker base colours than looks right in code; measure rendered pixels to match neighbours.
- **The car never moves.** The world is transformed around it (yaw, then pitch, then translation). Anything added to the world must go through `TrackPath` poses, heights and the road-centre offset.
- **Do not stack ground layers.** On a sloping, curving road, stacked strips triangulate differently and poke through each other. Lay strips side by side sharing edges (`track-layout.rowSide`).
- **A lap doubles back on itself.** Wide geometry from one stretch will land on another (hairpins, parallel straights). Use `circuit.sideRoomAt` / `clearanceAt` before placing anything wide.
- **On-screen angles are exaggerated for legibility** (`steerVis` is about 6x the true steer). Feed physics and aero the true value.

### Working method
- **Headless Chromium here renders in software at roughly 2-5 fps**, and simulation time is capped per frame, so one lap of Spa takes about 15 minutes. Run long browser checks in the background, and **do not edit project files while one is running**: the dev server reloads the page and voids the run.
- **Deploy = merge to `main`** (GitHub Pages workflow, about 35 s). The site is a PWA, so tell the user to hard-refresh (Ctrl+Shift+R).
- **The deploy workflow does not run the tests.** Run `npx vitest run` and `vite build` locally before every merge.
- **When behaviour changes, say so plainly** (for example: the car no longer reaches the selected speed because it now brakes for corners).
- **State what was not verified.** The user acted on "I cannot hear this" and "the elevation is my estimate"; hiding those would have cost more.

### Useful scripts (all need `npm start` on port 3000)
- `scripts/verify-lap-sweep.mjs` — road visible at every station of the lap.
- `scripts/verify-spa.mjs` — drives a timed lap and compares with the solved ideal (slow).
- `scripts/verify-vehicle-model.mjs` — vehicle model, telemetry and aero controls.
- The older `scripts/verify-*.mjs` have not been re-run since the vehicle model, Spa and the new sound landed; treat their assertions as possibly stale.
