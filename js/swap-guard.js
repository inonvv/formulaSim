/**
 * swap-guard.js — monotonically increasing token guard for racy async swaps.
 *
 * Used by main.js spawnCar to drop the trailing continuation of an in-flight
 * car load when a newer car has been requested. Without this guard, two
 * concurrent spawnCar calls both append their loaded group to the scene
 * (orphan-car ghost).
 *
 * Contract:
 *   const guard = createSwapGuard();
 *   const myToken = guard.begin();
 *   const grp = await buildCar(type);
 *   if (!guard.isCurrent(myToken)) return;   // a newer swap has superseded us
 *   // ... safe to mutate scene + state
 */
export function createSwapGuard() {
  let current = 0;
  return {
    begin() { return ++current; },
    isCurrent(token) { return token === current; },
  };
}
