import { describe, it, expect } from 'vitest';
import { createSwapGuard } from '../swap-guard.js';

/* Simulates main.js spawnCar with the swap-guard wired in. The actual
 * spawnCar lives inside main.js (which can't load in node), so this test
 * exercises the exact pattern used there to prove the contract holds. */
function makeSpawner({ scene, state, buildCar }) {
  const guard = createSwapGuard();
  return async function spawnCar(type) {
    const myToken = guard.begin();
    if (state.carGroup) scene.remove(state.carGroup);
    const grp = await buildCar(type);
    if (!guard.isCurrent(myToken)) return;   // newer swap superseded — bail
    state.carGroup = grp;
    state.carType  = type;
    scene.add(grp);
  };
}

function fakeScene() {
  const children = [];
  return {
    children,
    add(c) { children.push(c); },
    remove(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
  };
}

/* Deferred Promise — caller resolves manually. Lets us interleave two
 * concurrent spawnCar calls in a controlled order. */
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

describe('spawn-car race — swap-guard contract', () => {
  it('only one car ends up in scene when two spawns race; the second wins', async () => {
    const scene = fakeScene();
    const state = { carGroup: null, carType: null };

    const f1Defer = deferred();
    const gtDefer = deferred();
    const buildCar = (type) => {
      if (type === 'F1') return f1Defer.promise.then(() => ({ name: 'car', type: 'F1' }));
      if (type === 'GT') return gtDefer.promise.then(() => ({ name: 'car', type: 'GT' }));
      throw new Error('unexpected type ' + type);
    };

    const spawnCar = makeSpawner({ scene, state, buildCar });

    // Kick both, in the order: F1 first (the initial fire-and-forget), then
    // GT (the user click that races against it).
    const p1 = spawnCar('F1');
    const p2 = spawnCar('GT');

    // Resolve in the *opposite* order to maximise mischief — GT (the user
    // wants it) finishes first, F1 finishes after. Without the guard, F1
    // would clobber state.carGroup and re-add itself to the scene.
    gtDefer.resolve();
    await p2;
    f1Defer.resolve();
    await p1;

    expect(scene.children.length).toBe(1);
    expect(scene.children[0].type).toBe('GT');
    expect(state.carType).toBe('GT');
    expect(state.carGroup.type).toBe('GT');
  });

  it('back-to-back-without-overlap behaves like normal sequential swaps', async () => {
    const scene = fakeScene();
    const state = { carGroup: null, carType: null };
    const buildCar = (type) => Promise.resolve({ name: 'car', type });
    const spawnCar = makeSpawner({ scene, state, buildCar });

    await spawnCar('F1');
    expect(scene.children.length).toBe(1);
    expect(state.carType).toBe('F1');

    await spawnCar('GT');
    expect(scene.children.length).toBe(1);   // old F1 removed
    expect(state.carType).toBe('GT');
  });

  it('three-way race: only the last spawn wins; earlier two are discarded', async () => {
    const scene = fakeScene();
    const state = { carGroup: null, carType: null };
    const defs = { F1: deferred(), F2: deferred(), F3: deferred() };
    const buildCar = (type) => defs[type].promise.then(() => ({ name: 'car', type }));
    const spawnCar = makeSpawner({ scene, state, buildCar });

    const p1 = spawnCar('F1');
    const p2 = spawnCar('F2');
    const p3 = spawnCar('F3');

    // Resolve in scrambled order
    defs.F2.resolve();
    defs.F1.resolve();
    defs.F3.resolve();
    await Promise.all([p1, p2, p3]);

    expect(scene.children.length).toBe(1);
    expect(state.carType).toBe('F3');
  });
});

describe('createSwapGuard unit', () => {
  it('begin returns monotonically increasing tokens', () => {
    const g = createSwapGuard();
    expect(g.begin()).toBe(1);
    expect(g.begin()).toBe(2);
    expect(g.begin()).toBe(3);
  });

  it('only the most recently begun token is current', () => {
    const g = createSwapGuard();
    const t1 = g.begin();
    const t2 = g.begin();
    expect(g.isCurrent(t1)).toBe(false);
    expect(g.isCurrent(t2)).toBe(true);
  });
});
