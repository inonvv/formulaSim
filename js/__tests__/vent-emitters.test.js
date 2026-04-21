import { describe, it, expect, vi } from 'vitest';

/* ── DOM stub so CanvasTexture / canvas helpers don't crash in node ── */
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0, height: 0,
          getContext() {
            return {
              createRadialGradient: () => ({ addColorStop: () => {} }),
              fillRect: () => {},
              set fillStyle(_v) {},
            };
          },
        };
      }
      return {};
    },
  };
}

/* ── Three.js mock ────────────────────────────────────────────────── */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };

  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };

  function Group() {
    this.name = '';
    this.children = [];
    this.position = new Vec3();
    this.rotation = new Euler();
    this.visible = true;
  }
  Group.prototype.add    = function (...items) { this.children.push(...items); return this; };
  Group.prototype.remove = function (item)     { this.children = this.children.filter(c => c !== item); return this; };

  function Points(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {};
    this.visible = true;
  }

  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }
  function BufferAttribute(array, itemSize) {
    this.array = array; this.itemSize = itemSize; this.needsUpdate = false;
  }

  function PointsMaterial(opts = {}) { Object.assign(this, opts); this.dispose = () => {}; }
  function CanvasTexture(source) {
    this.image = source || {};
    this.needsUpdate = false;
    this.dispose = () => {};
  }

  const AdditiveBlending = 2;

  return {
    Group, Points,
    BufferGeometry, BufferAttribute,
    PointsMaterial, CanvasTexture,
    Vector3: Vec3, Euler,
    AdditiveBlending,
  };
});

function makeScene() {
  return {
    _objects: [],
    add(o)    { this._objects.push(o); },
    remove(o) { this._objects = this._objects.filter(x => x !== o); },
  };
}

/* ── Shared test measure — 3 role-tagged anchors (2 inlets + 1 outlet) ── */
function makeMeasure() {
  return {
    anchors: {
      sidepodInletL: {
        x: -0.70, y: 0.0142, z: -0.2708,
        direction: { x: 0.2425, y: 0, z: -0.9701 },
        role: 'inlet',
      },
      sidepodInletR: {
        x:  0.70, y: 0.0142, z: -0.2708,
        direction: { x: -0.2425, y: 0, z: -0.9701 },
        role: 'inlet',
      },
      exhaustPipe: (() => {
        // Normalise (0, 0.1, 1) to unit length so |velocity| equals the
        // configured magnitude exactly.
        const x = 0, y = 0.1, z = 1;
        const L = Math.sqrt(x * x + y * y + z * z);
        return {
          x: 0, y: 0.1541, z: 2.2622,
          direction: { x: x / L, y: y / L, z: z / L },
          role: 'outlet',
        };
      })(),
      // Non-role anchor that MUST be ignored:
      halo: { x: 0, y: 0.373, z: -0.05 },
    },
  };
}

describe('VentEmitterSystem', () => {
  it('V1. constructs without throwing', async () => {
    const { VentEmitterSystem } = await import('../vent-emitters.js');
    expect(() => new VentEmitterSystem(makeScene())).not.toThrow();
  });

  it('V2. setCarType produces an emitter count matching role-tagged anchors', async () => {
    const { VentEmitterSystem } = await import('../vent-emitters.js');
    const ves = new VentEmitterSystem(makeScene());
    ves.setCarType('F1', makeMeasure());
    // 2 inlets + 1 outlet = 3 role-tagged. halo has no role → ignored.
    expect(ves._emitters.length).toBe(3);
    const roles = ves._emitters.map(e => e.role).sort();
    expect(roles).toEqual(['inlet', 'inlet', 'outlet']);
  });

  it('V3. inlet particle position starts AHEAD of anchor along +direction, converges as phase advances', async () => {
    const { VentEmitterSystem } = await import('../vent-emitters.js');
    const ves = new VentEmitterSystem(makeScene());
    ves.setVisible(true);
    ves.setCarType('F1', makeMeasure());

    // Find first particle belonging to sidepodInletL (emitter index 0).
    let i = -1;
    for (let k = 0; k < ves._capacity; k++) {
      if (ves._emIdx[k] === 0) { i = k; break; }
    }
    expect(i).toBeGreaterThanOrEqual(0);

    // Force phase = 0 and check pos = anchor + dir × 1.5 m
    ves._phase[i] = 0;
    ves._writeInletPos(i);
    const em = ves._emitters[0];
    const pAhead = {
      x: ves._pos[i * 3],
      y: ves._pos[i * 3 + 1],
      z: ves._pos[i * 3 + 2],
    };
    expect(pAhead.x).toBeCloseTo(em.pos.x + em.dir.x * 1.5, 5);
    expect(pAhead.y).toBeCloseTo(em.pos.y + em.dir.y * 1.5, 5);
    expect(pAhead.z).toBeCloseTo(em.pos.z + em.dir.z * 1.5, 5);

    // Advance phase to 1 → particle lands AT the anchor
    ves._phase[i] = 1;
    ves._writeInletPos(i);
    expect(ves._pos[i * 3]).toBeCloseTo(em.pos.x, 5);
    expect(ves._pos[i * 3 + 1]).toBeCloseTo(em.pos.y, 5);
    expect(ves._pos[i * 3 + 2]).toBeCloseTo(em.pos.z, 5);

    // Distance from anchor is strictly larger at p=0 than at p=0.5
    ves._phase[i] = 0;
    ves._writeInletPos(i);
    const d0 = Math.hypot(
      ves._pos[i * 3]     - em.pos.x,
      ves._pos[i * 3 + 1] - em.pos.y,
      ves._pos[i * 3 + 2] - em.pos.z,
    );
    ves._phase[i] = 0.5;
    ves._writeInletPos(i);
    const d5 = Math.hypot(
      ves._pos[i * 3]     - em.pos.x,
      ves._pos[i * 3 + 1] - em.pos.y,
      ves._pos[i * 3 + 2] - em.pos.z,
    );
    expect(d0).toBeGreaterThan(d5);
  });

  it('V4. outlet particle velocity scales with setSpeed (2× speed preserves direction)', async () => {
    const { VentEmitterSystem } = await import('../vent-emitters.js');
    const ves = new VentEmitterSystem(makeScene());
    ves.setVisible(true);

    // At speed 0: magnitude = 8 m/s (base).
    ves.setSpeed(0);
    ves.setCarType('F1', makeMeasure());
    // Find particle tied to outlet emitter (role='outlet').
    const outletIdx = ves._emitters.findIndex(e => e.role === 'outlet');
    expect(outletIdx).toBeGreaterThanOrEqual(0);
    let j = -1;
    for (let k = 0; k < ves._capacity; k++) {
      if (ves._emIdx[k] === outletIdx) { j = k; break; }
    }
    expect(j).toBeGreaterThanOrEqual(0);
    // Force respawn at current speed=0.
    ves._spawn(j);
    const magLow = Math.hypot(
      ves._vel[j * 3], ves._vel[j * 3 + 1], ves._vel[j * 3 + 2],
    );
    expect(magLow).toBeCloseTo(8, 5);

    // At speed 200: magnitude = 8 + 200 × 0.05 = 18 m/s.
    ves.setSpeed(200);
    ves._spawn(j);
    const magHigh = Math.hypot(
      ves._vel[j * 3], ves._vel[j * 3 + 1], ves._vel[j * 3 + 2],
    );
    expect(magHigh).toBeCloseTo(18, 5);
    // Direction preserved: velocity parallel to emitter.dir (checked via component ratio).
    const em = ves._emitters[outletIdx];
    expect(ves._vel[j * 3]).toBeCloseTo(em.dir.x * magHigh, 5);
    expect(ves._vel[j * 3 + 1]).toBeCloseTo(em.dir.y * magHigh, 5);
    expect(ves._vel[j * 3 + 2]).toBeCloseTo(em.dir.z * magHigh, 5);
  });

  it('V5. setBaseY lifts the group position.y', async () => {
    const { VentEmitterSystem } = await import('../vent-emitters.js');
    const ves = new VentEmitterSystem(makeScene());
    expect(ves.group.position.y).toBe(0);
    ves.setBaseY(0.283);
    expect(ves.group.position.y).toBeCloseTo(0.283, 6);
  });

  it('V6. mirrored-anchor inlets have x = -source.x and direction.x = -source.direction.x', async () => {
    const { VentEmitterSystem } = await import('../vent-emitters.js');
    const ves = new VentEmitterSystem(makeScene());
    const measure = makeMeasure();
    ves.setCarType('F1', measure);

    const l = ves._emitters.find(e => e.key === 'sidepodInletL');
    const r = ves._emitters.find(e => e.key === 'sidepodInletR');
    expect(l).toBeDefined();
    expect(r).toBeDefined();
    expect(r.pos.x).toBeCloseTo(-l.pos.x, 5);
    expect(r.pos.y).toBeCloseTo(l.pos.y, 5);
    expect(r.pos.z).toBeCloseTo(l.pos.z, 5);
    expect(r.dir.x).toBeCloseTo(-l.dir.x, 5);
    expect(r.dir.y).toBeCloseTo(l.dir.y, 5);
    expect(r.dir.z).toBeCloseTo(l.dir.z, 5);
  });
});
