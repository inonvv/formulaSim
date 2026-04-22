import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* Minimal three mock — only what the overlay needs. */
vi.mock('three', () => {
  const calls = {};
  class Group { constructor(){ this.children = []; this.position = { y: 0 }; } add(x){ this.children.push(x); } remove(x){ this.children = this.children.filter(c=>c!==x); } traverse(fn){ fn(this); this.children.forEach(c => c.traverse ? c.traverse(fn) : fn(c)); } }
  class Scene extends Group {}
  class GridHelper { constructor(){ this.position = { y: 0 }; } }
  class AxesHelper {}
  class BoxHelper { constructor(o, c){ this.object = o; this.color = c; this.geometry = { dispose: () => {} }; this.material = { dispose: () => {} }; } }
  return { Group, Scene, GridHelper, AxesHelper, BoxHelper };
});

describe('debug-overlay gate', () => {
  const origLocation = global.window?.location;

  beforeEach(() => {
    vi.resetModules();
    global.window = { location: { search: '' } };
    global.document = {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: () => ({ style: {}, id: '', textContent: '', appendChild() {} }),
    };
  });

  afterEach(() => {
    if (origLocation) global.window.location = origLocation;
  });

  it('is a no-op when ?debug=1 is absent', async () => {
    global.window.location.search = '';
    const { createDebugOverlay, isDebugEnabled } = await import('../debug-overlay.js');
    expect(isDebugEnabled()).toBe(false);
    const scene = { add: vi.fn(), remove: vi.fn() };
    const overlay = createDebugOverlay(scene);
    expect(overlay.enabled).toBe(false);
    // attach/detach must not crash or touch the scene
    overlay.attach({}, {}, {});
    overlay.detach();
    expect(scene.add).not.toHaveBeenCalled();
  });

  it('activates when ?debug=1 is present and adds a grid to the scene', async () => {
    global.window.location.search = '?debug=1';
    const { createDebugOverlay, isDebugEnabled } = await import('../debug-overlay.js');
    expect(isDebugEnabled()).toBe(true);
    const scene = { add: vi.fn(), remove: vi.fn() };
    const overlay = createDebugOverlay(scene);
    expect(overlay.enabled).toBe(true);
    expect(scene.add).toHaveBeenCalled();  // GridHelper was added
  });
});
