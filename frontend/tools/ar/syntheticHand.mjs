/**
 * Synthetic ground truth for hand-AR alignment — a small 3D KINEMATIC hand, independent of the mapping under test.
 *
 * Start: the view's 21-point reference skeleton (reference pixels, z = 0) plus a set of MARKINGS, each rigidly attached
 * to ONE body (the palm, or one bone of one finger) — hard attachment, no blending.
 * Then, exactly as a real hand would differ from the drawing and move:
 *   1. own proportions: palm length/width scale and per-finger length scale; a curved palm (metacarpal arch);
 *   2. finger spread (in-plane rotation of a finger about its MCP) and thumb swing about its CMC;
 *   3. finger FLEXION: 3D rotation of the distal part of a finger about each joint (MCP, PIP, DIP), out of the hand plane;
 *   4. a 3D tilt/roll of the whole hand, then a PINHOLE camera projection (real perspective, not an affine);
 *   5. placement anywhere in the video frame, then optional Gaussian landmark noise and outliers (landmarks only — the
 *      ground-truth markings are exact).
 * The mapping under test only ever sees the projected (noisy) 21 landmarks, like MediaPipe output. Its predicted
 * marking positions are compared with the exactly projected markings.
 *
 * Deterministic: everything is driven by a seeded PRNG.
 */
import { getReferenceLandmarks } from '../../src/tracking/referenceLandmarks.js';
import { BONES, PALM, PALM_POLYGON, pointInPolygon, segmentDistance, palmLength } from '../../src/tracking/handSkeleton.js';

export const VIEW_DIMS = Object.freeze({ left_front: [1586, 1982], right_front: [1585, 1983], left_back: [1585, 1981], right_back: [1971, 2010] });

export function prng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => { const u = Math.max(next(), 1e-12); const v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return { next, uniform: (a, b) => a + (b - a) * next(), gauss };
}

const FINGER_OF = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], little: [17, 18, 19, 20] };
const segIndexOf = (boneId) => { const b = BONES.find((x) => x.id === boneId); return { finger: b.finger, k: FINGER_OF[b.finger].indexOf(b.a) }; };

/** The view's reference skeleton in reference pixels. */
export function referencePx(view) {
  const [W, H] = VIEW_DIMS[view];
  return getReferenceLandmarks(view).map((p) => ({ x: p.x * W, y: p.y * H }));
}

/**
 * Test markings for a view: points on every bone (3 along × 3 across, within the finger's width) and a grid inside the
 * palm. Each carries its true body and its reference position (normalized, as the Studio saves it).
 */
export function sampleMarkings(view) {
  const [W, H] = VIEW_DIMS[view];
  const ref = referencePx(view);
  const L = palmLength(ref);
  const half = 0.05 * L; // roughly half a finger width
  const out = [];
  for (const bone of BONES) {
    const a = ref[bone.a]; const b = ref[bone.b];
    const u = { x: b.x - a.x, y: b.y - a.y }; const l = Math.hypot(u.x, u.y);
    const n = { x: -u.y / l, y: u.x / l };
    for (const t of [0.25, 0.5, 0.75]) {
      for (const k of [-0.6, 0, 0.6]) {
        const p = { x: a.x + u.x * t + n.x * half * k, y: a.y + u.y * t + n.y * half * k };
        out.push({ id: `${bone.id}@${t}/${k}`, body: bone.id, ref: p, norm: { x: p.x / W, y: p.y / H } });
      }
    }
  }
  const poly = PALM_POLYGON.map((i) => ref[i]);
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length; const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  for (let gx = -0.6; gx <= 0.6001; gx += 0.2) {
    for (let gy = -0.6; gy <= 0.6001; gy += 0.2) {
      const p = { x: cx + gx * L * 0.7, y: cy + gy * L * 0.9 };
      // keep palm points clearly inside the palm (not on a finger root, where "palm" vs "bone" is a matter of definition)
      const nearBone = BONES.some((bn) => segmentDistance(p, ref[bn.a], ref[bn.b]).d < 0.12 * L);
      if (pointInPolygon(p, poly) && !nearBone) out.push({ id: `palm@${gx.toFixed(1)},${gy.toFixed(1)}`, body: PALM, ref: p, norm: { x: p.x / W, y: p.y / H } });
    }
  }
  return out;
}

// --- 3D helpers
const rotAxis = (p, o, axis, ang) => {
  // Rodrigues rotation of p about the axis through o.
  const c = Math.cos(ang); const s = Math.sin(ang);
  const v = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
  const k = axis;
  const dotkv = k.x * v.x + k.y * v.y + k.z * v.z;
  const cross = { x: k.y * v.z - k.z * v.y, y: k.z * v.x - k.x * v.z, z: k.x * v.y - k.y * v.x };
  return {
    x: o.x + v.x * c + cross.x * s + k.x * dotkv * (1 - c),
    y: o.y + v.y * c + cross.y * s + k.y * dotkv * (1 - c),
    z: o.z + v.z * c + cross.z * s + k.z * dotkv * (1 - c),
  };
};

/**
 * One posed, projected hand.
 * pose: { lengthScale, widthScale, fingerScale{finger}, spread{finger} (rad), thumbSwing (rad),
 *         flex{finger: [mcp, pip, dip]} (rad), tiltX, tiltY, roll (rad), size (palm length in video px),
 *         center {x,y} video px, perspective (camera distance / hand size; Infinity = orthographic), face: 'front'|'back' }
 * Returns { landmarks: 21 video px (exact), markings: [{ id, body, norm, truth: video px }] }.
 */
export function poseHand(view, markings, pose) {
  const ref = referencePx(view);
  const L = palmLength(ref);
  const wrist = ref[0];
  const up = { x: ref[9].x - wrist.x, y: ref[9].y - wrist.y }; const ul = Math.hypot(up.x, up.y);
  const u = { x: up.x / ul, y: up.y / ul }; const n = { x: -u.y, y: u.x };
  // all points: landmarks then markings, with their body
  const bodyOfLandmark = (i) => {
    if (PALM_POLYGON.includes(i) && i !== 1) return { finger: null, k: -1 };
    for (const [f, chain] of Object.entries(FINGER_OF)) {
      const k = chain.indexOf(i);
      if (k > 0 || (f === 'thumb' && k >= 0)) return { finger: f, k: f === 'thumb' ? k : k }; // k: index of the joint this point sits after
    }
    return { finger: null, k: -1 };
  };
  const pts = [
    ...ref.map((p, i) => ({ ...p, z: 0, body: bodyOfLandmark(i), lm: i })),
    ...markings.map((m) => ({ x: m.ref.x, y: m.ref.y, z: 0, mark: m, body: m.body === PALM ? { finger: null, k: -1 } : (() => { const s = segIndexOf(m.body); return { finger: s.finger, k: s.k + 0.5 }; })() })),
  ];
  // 1. proportions (about the wrist, in the hand frame)
  for (const p of pts) {
    const d = { x: p.x - wrist.x, y: p.y - wrist.y };
    const a = (d.x * u.x + d.y * u.y) * pose.lengthScale; const b = (d.x * n.x + d.y * n.y) * pose.widthScale;
    p.x = wrist.x + a * u.x + b * n.x; p.y = wrist.y + a * u.y + b * n.y;
  }
  // 1b. palm ARCH: a real palm is not flat — the metacarpal (transverse) arch puts the index and little knuckles and the
  // palm's sides deeper than its centre line. Depth grows with the square of the distance from the middle axis.
  if (pose.palmArch) {
    const half = 0.5 * Math.hypot(ref[17].x - ref[5].x, ref[17].y - ref[5].y);
    for (const p of pts) {
      const b = (p.x - wrist.x) * n.x + (p.y - wrist.y) * n.y;
      const mid = (ref[9].x - wrist.x) * n.x + (ref[9].y - wrist.y) * n.y; // the middle finger's lateral position
      p.z -= pose.palmArch * L * ((b - mid) / half) ** 2;
    }
  }
  const lmAt = (i) => pts[i];
  for (const [finger, chain] of Object.entries(FINGER_OF)) {
    const root = { ...lmAt(chain[0]) };
    const mine = (p) => p.body.finger === finger && p.body.k > 0;
    const thumbAll = (p) => p.body.finger === 'thumb';
    // finger length about its root joint
    const fs = pose.fingerScale?.[finger] ?? 1;
    for (const p of pts) if (mine(p)) { p.x = root.x + (p.x - root.x) * fs; p.y = root.y + (p.y - root.y) * fs; }
    // spread / thumb swing: in-plane rotation about the root
    const ang = finger === 'thumb' ? (pose.thumbSwing || 0) : (pose.spread?.[finger] || 0);
    if (ang) for (const p of pts) if (finger === 'thumb' ? thumbAll(p) && p.body.k > 0 : mine(p)) Object.assign(p, rotAxis(p, { ...root, z: 0 }, { x: 0, y: 0, z: 1 }, ang));
    // flexion about each joint, out of the plane (front views flex towards the camera, back views away)
    const flex = pose.flex?.[finger] || [0, 0, 0];
    const dir = pose.face === 'back' ? -1 : 1;
    const joints = [0, 1, 2]; // positions in the chain: MCP, PIP, DIP (thumb: CMC, MCP, IP)
    joints.forEach((jk, idx) => {
      const ang2 = flex[idx] || 0;
      if (!ang2) return;
      const j = lmAt(chain[jk]); const nxt = lmAt(chain[jk + 1]);
      const axisDir = { x: nxt.x - j.x, y: nxt.y - j.y, z: nxt.z - j.z };
      // lateral axis: perpendicular to the bone, within the hand plane
      let ax = { x: -axisDir.y, y: axisDir.x, z: 0 }; const al = Math.hypot(ax.x, ax.y) || 1; ax = { x: ax.x / al, y: ax.y / al, z: 0 };
      for (const p of pts) if (p.body.finger === finger && p.body.k > jk) Object.assign(p, rotAxis(p, j, ax, dir * ang2));
    });
  }
  // 4. global 3D rotation about the palm centre, then projection
  const c = { x: (ref[0].x + ref[9].x) / 2, y: (ref[0].y + ref[9].y) / 2, z: 0 };
  for (const p of pts) {
    let q = rotAxis(p, c, { x: 1, y: 0, z: 0 }, pose.tiltX || 0);
    q = rotAxis(q, c, { x: 0, y: 1, z: 0 }, pose.tiltY || 0);
    q = rotAxis(q, c, { x: 0, y: 0, z: 1 }, pose.roll || 0);
    Object.assign(p, q);
  }
  const scale = pose.size / L;
  const D = Number.isFinite(pose.perspective) ? pose.perspective * L : Infinity;
  const project = (p) => {
    const k = Number.isFinite(D) ? D / (D - p.z) : 1; // z towards the camera
    return { x: pose.center.x + (p.x - c.x) * k * scale, y: pose.center.y + (p.y - c.y) * k * scale };
  };
  const landmarks = pts.filter((p) => p.lm !== undefined).map(project);
  const marks = pts.filter((p) => p.mark).map((p) => ({ id: p.mark.id, body: p.mark.body, norm: p.mark.norm, ref: p.mark.ref, truth: project(p) }));
  return { landmarks, markings: marks };
}

/** A random pose for a condition: 'flat' | 'natural' | 'hard'. */
export const CONDITIONS = Object.freeze({
  flat: { tilt: 10, flex: 0, spread: 3, thumb: 4, prop: 0.06, finger: 0.05, perspective: 3.0, arch: 0.04 },
  natural: { tilt: 20, flex: 25, spread: 8, thumb: 10, prop: 0.12, finger: 0.12, perspective: 2.5, arch: 0.08 },
  hard: { tilt: 35, flex: 50, spread: 12, thumb: 20, prop: 0.15, finger: 0.15, perspective: 2.0, arch: 0.12 },
});

export function randomPose(rng, condition, view, video = { width: 1280, height: 720 }) {
  const c = CONDITIONS[condition];
  const deg = Math.PI / 180;
  const fingers = ['thumb', 'index', 'middle', 'ring', 'little'];
  const pose = {
    lengthScale: 1 + rng.uniform(-c.prop, c.prop),
    widthScale: 1 + rng.uniform(-c.prop, c.prop),
    fingerScale: Object.fromEntries(fingers.map((f) => [f, 1 + rng.uniform(-c.finger, c.finger)])),
    spread: Object.fromEntries(fingers.map((f) => [f, rng.uniform(-c.spread, c.spread) * deg])),
    thumbSwing: rng.uniform(-c.thumb, c.thumb) * deg,
    flex: Object.fromEntries(fingers.map((f) => [f, [0, 1, 2].map(() => rng.uniform(0, c.flex) * deg)])),
    tiltX: rng.uniform(-c.tilt, c.tilt) * deg,
    tiltY: rng.uniform(-c.tilt, c.tilt) * deg,
    roll: rng.uniform(-40, 40) * deg,
    size: rng.uniform(0.25, 0.45) * Math.min(video.width, video.height),
    center: { x: video.width * rng.uniform(0.4, 0.6), y: video.height * rng.uniform(0.4, 0.6) },
    perspective: c.perspective,
    palmArch: rng.uniform(0, c.arch) * (view.endsWith('back') ? -1 : 1), // palm cups away from a back-facing camera
    face: view.endsWith('back') ? 'back' : 'front',
  };
  return pose;
}

/** Adds Gaussian noise (sigma in palm widths) to landmarks. */
export function noisy(landmarks, rng, sigmaPalmWidths) {
  if (!sigmaPalmWidths) return landmarks.map((p) => ({ ...p }));
  const pw = Math.hypot(landmarks[17].x - landmarks[5].x, landmarks[17].y - landmarks[5].y);
  return landmarks.map((p) => ({ x: p.x + rng.gauss() * sigmaPalmWidths * pw, y: p.y + rng.gauss() * sigmaPalmWidths * pw }));
}

/** Old 6-point reference table (before this change) — only for the "legacy" comparison row. */
export const LEGACY_SIX = Object.freeze({
  left_front: [[0.37, 0.95], [0.1, 0.55], [0.39, 0.44], [0.55, 0.43], [0.73, 0.44], [0.9, 0.45]],
  right_front: [[0.63, 0.95], [0.9, 0.55], [0.61, 0.43], [0.445, 0.43], [0.26, 0.43], [0.095, 0.46]],
  left_back: [[0.62, 0.95], [0.75, 0.6], [0.605, 0.43], [0.435, 0.42], [0.265, 0.43], [0.1, 0.45]],
  right_back: [[0.29, 0.94], [0.1, 0.6], [0.315, 0.42], [0.445, 0.41], [0.59, 0.42], [0.715, 0.44]],
});
