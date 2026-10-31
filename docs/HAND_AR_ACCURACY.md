# Hand AR accuracy — architecture, evidence, validation

How the camera places a protocol's markings on a live hand, why the previous version misplaced them, what has been
**measured** (synthetic only, so far), and how to measure real-camera accuracy. Read with `docs/CAMERA_AR.md` (the
feature) and `docs/REAL_DEVICE_VALIDATION.md` (the device checklist).

> **Status of the evidence.** Everything below marked *synthetic* comes from generated hands with exact ground truth.
> It proves the geometry and the tracking logic, not real-world accuracy. **No real-camera recordings have been
> measured yet**, so no real-world accuracy claim is made. Section 7 explains how to get one.

## 1. Root causes found (traced from the saved marking to the screen)

Pipeline: saved marking (normalized to the view's PNG) → reference pixels → fit to live MediaPipe landmarks → video
pixels → `object-fit: cover` mapping → canvas. Pixel-space fitting, cover cropping and mirroring were already correct and
tested. The errors were in the **reference data** and the **model**.

| # | Cause | Effect | Fix |
|---|---|---|---|
| 1 | The 6-point reference table put the **wrist** on the outer *edge* of the wrist in all four views (the outline's end tick), not at the wrist centre. Off by **0.37–0.40 palm lengths**. | Every marking was pulled sideways/rotated by the least-squares fit. | Measured 21-point skeleton per view (`tracking/referenceLandmarks.js`); the wrist is the centre of the drawn wrist crease. |
| 2 | The reference **thumb "MCP"** sat near the thumb's IP joint / tip. Off by **0.18–0.36 palm lengths**. | Same as 1, plus wrong scale. | Thumb CMC/MCP/IP/tip measured from the drawn creases. |
| 3 | **One similarity transform for the whole hand** (6 points). | Fingers that bend, spread, or are longer or shorter than the drawing put their markings beside the finger. Palm proportions differ from the drawing. There is no perspective. | 2D **skeleton mapping**: palm transform plus a frame per finger bone, blended per marking (section 2). |
| 4 | Only 6 of MediaPipe's 21 landmarks were used. | Finger joints were ignored. | All 21 are used. |
| 5 | Smoothing was on the 6 points only, with no outlier handling, no hold or fade, and no reliability measure. | Shake, single-landmark glitches, and markings shown on a finger the tracker had lost. | Temporal tracker (section 4). |
| 6 | The canvas buffer ignored `devicePixelRatio`. | Blurry overlay on phones. Positions were still correct. | The buffer is the CSS size × DPR (capped at 2), so mappings stay exact (tested). |
| 7 | *(Bug from the previous delivery)* The debug FPS readout always showed 0: the React state updater ran after the counter was reset. | The developer readout was wrong. | Fixed. |

Synthetic size of causes 1–3 (palm widths; 0.05 ≈ 4 mm on an adult palm). Old design: median **0.205**, p95 **0.397**.
Old fit with only the reference points corrected: median 0.068, p95 0.280. New design: median **0.0067**, p95 **0.021**
(the natural-pose condition, section 6).

## 2. Architecture selected

```
MediaPipe HandLandmarker (in the browser, 21 landmarks, VIDEO mode)
  → per-frame checks: hand present · one hand · confidence · left/right chirality        (arFrame.js, cameraGuidance.js)
  → guided calibration (first ~0.5 s of a steady, flat, open hand)                        (calibration.js)
  → temporal tracker: outlier rejection · One Euro (confidence-aware) · 20 ms prediction
                      · hold/fade on dropout · reacquisition · per-finger reliability     (handTracker.js)
  → region transforms every frame:                                                        (handSkeleton.js)
        palm  = homography of the 6 palm landmarks (perspective), affine fallback when ill-conditioned
        each of 15 bones = bone frame (length from the live bone, width from the hand scale)
  → per marking: fixed skinning weights (computed once from where it sits on the drawing) or a doctor-pinned anchor
        → blended local affine → position, radius/stroke scale, shape matrix               (protocolMapper.js)
  → drawn in the protocol's layer order, opacity × visibility (fade / reliability)          (drawProtocolOverlay.js)
```

Why 2D linear-blend skinning:
- A ring on a finger follows that finger, not the whole hand.
- A palm dot follows the palm.
- A marking on a joint blends smoothly between the two bones, so there are no seams where regions meet.
- It is deterministic and has no training. It costs ≈ 0.1 ms per frame for 30 markings (Node, synthetic).
- Its assumptions are explicit: rigid bones, and a nearly planar palm.

## 3. Options evaluated (and what was not adopted)

| Option | Decision | Reason |
|---|---|---|
| MediaPipe Hand Landmarker (already used, Apache-2.0, local WASM/GPU) | **Kept** | 21 landmarks per hand at real-time rates in the browser, with no frames leaving the device. VIDEO mode already tracks between frames internally. |
| MediaPipe world landmarks / relative `z` | **Used for the tilt check only** | Relative depth flags a tilted hand during calibration. It is not metric enough to reconstruct the surface. |
| Gesture recognizer | Not used | It does not improve geometry. |
| Hand segmentation | Not used | MediaPipe Tasks has no hand-specific segmenter. Fitting the drawing's outline to a mask needs a contour correspondence model and labelled data, so there is no demonstrated gain. |
| Optical flow between detections | Not used | MediaPipe already tracks between frames, and the detector runs every frame. |
| Learned / fine-tuned anatomical regression | Not possible now | It needs a labelled dataset of real hands with marking ground truth. None exists. The validation export (section 7) is a first step towards one. |
| 3D parametric hand (MANO) | Not adopted | Its licence is non-commercial. It needs heavy per-frame fitting and real 3D calibration. A monocular webcam cannot recover the hidden 3D surface reliably. |
| Global affine / homography for the whole hand | Evaluated | It cannot follow individual fingers (table in section 6). |
| Palm **homography** vs palm affine | **Homography, gated** | Synthetic: palm-marking median 0.013 → 0.006 (natural), 0.029 → 0.013 (hard). Equal at 2 % landmark noise. It is used only when well-conditioned over the palm; otherwise the affine. `?palm=affine` compares them on a device. |
| Forward prediction | **20 ms** | Without it the filter lagged the 4 Hz shake test (p95 0.12). With 20 ms all temporal criteria pass across 4 views × 5 seeds. The synthetic test has zero render latency, so prediction *costs* error in the steady sweep (0.010 → 0.041). Real latency should favour it. Re-check with `?predict=0`. |

New dependencies: **none**. No model files, cloud services or paid APIs were added.

## 4. Motion stabilization (handTracker.js)

- **Real timestamps**: `performance.now()` per frame, with a variable frame rate handled.
- **Outlier rejection**: a single landmark far from its constant-velocity prediction (> 0.3 palm lengths and > 4× the
  median deviation) is replaced by the prediction, for at most 3 frames. More than 4 outliers at once marks the whole
  frame as unreliable, and it is handled as a dropout.
- **One Euro filter** on all 21 points. Its speed unit is palm lengths per second, so it does not depend on resolution
  or distance. It is confidence-aware: a low MediaPipe score means heavier smoothing.
- **States** go searching → acquiring (3 good frames) → tracking:
  - When the hand drops out, the last pose is **held for 160 ms while fading**, then hidden.
  - If the hand returns near its last place, tracking continues with no snap.
  - If it returns far away, tracking re-acquires from scratch, so the overlay is never dragged across the screen.
- **A wrong hand or two hands hide the overlay at once.**
- **Per-finger reliability**:
  - Each bone's length, relative to the palm, is compared with the calibrated baseline.
  - A finger that curls, bends towards the camera or is mis-detected fades its markings.
  - It fades from 25 % deviation and is gone at 50 %.
- **Reset** on a change of view or protocol (the session remounts), on Stop/Exit, on a camera restart, on wrong hand,
  and on Recalibrate.

## 5. Calibration workflow (calibration.js, on by default; "Skip calibration" exists)

1. Start Camera. The banner asks for the view's hand and side ("left hand, palm facing the camera").
2. Hold the hand **flat, fingers straight and slightly spread, fully in frame**. Each frame is checked:
   - in frame, wrist included;
   - not too small or too close;
   - confidence ≥ 0.8;
   - fingers straight (≥ 0.9);
   - not tilted (relative `z` across and along the palm).

   Each failed check shows one plain instruction (`CALIBRATION_MESSAGES`).
3. Once the hand has been steady for 0.5 s (moving less than 0.05 palm lengths), the hand's **own proportions** are
   recorded and the markings appear. The progress bar fills in the banner.
4. **Recalibrate** at any time. Switching view or protocol, or restarting the camera, always recalibrates.

Calibration does not move markings on a flat hand. It gives the tracker the baseline that lets it tell a bent or curled
finger from a straight one. **It cannot tell palm from back of the hand.** In 2D, a left palm is the mirror image of a
right back, so the geometric check blocks a wrong *hand-or-side* but cannot separate the two. The UI always names both.

## 6. Synthetic results (frontend `npm run ar:benchmark`; acceptance in `npm test`)

The generator (`tools/ar/syntheticHand.mjs`) builds a 3D kinematic hand from the 21-point reference. It applies:
- own proportions (palm ±, each finger ±);
- a curved palm (metacarpal arch);
- finger flexion at each joint (out of plane), spread, and thumb swing;
- 3D tilt/roll and a **pinhole perspective camera**;
- Gaussian landmark noise (0.4 % of palm width).

Markings are rigidly attached to one body each (hard attachment), and only noisy 2D landmarks are given to the code under
test. Thresholds were fixed in `src/tracking/arAcceptance.js` **before** evaluation.

| Condition (25 poses × 4 views, ≈ 154 markings per pose) | Old design | Skeleton, affine palm | **Skeleton, perspective palm (shipped)** | Threshold | Result |
|---|---|---|---|---|---|
| flat (tilt ≤ 10°) — median / p95 | 0.211 / 0.364 | 0.0045 / 0.0105 | **0.0043 / 0.0093** | ≤ 0.02 / ≤ 0.05, ≥ 99 % within 0.08 | PASS (100 %) |
| natural (tilt ≤ 20°, flexion ≤ 25°/joint, ±12 % proportions) | 0.205 / 0.397 | 0.0073 / 0.0244 | **0.0067 / 0.0211** | ≤ 0.04 / ≤ 0.10, ≥ 95 % within 0.10 | PASS (100 %) |
| hard (tilt ≤ 35°, flexion ≤ 50°) — *outside supported conditions* | 0.243 / 0.615 | 0.0157 / 0.0704 | **0.0139 / 0.0688** (max 0.122) | none | reported |

The natural condition with heavier landmark noise:

| Landmark noise | Median | p95 |
|---|---|---|
| 1 % | 0.0118 | 0.0275 |
| 2 % | 0.0207 | 0.0454 |

| Temporal (30 fps, 0.5 % noise) | Measured | Threshold | Result |
|---|---|---|---|
| Stationary jitter RMS (raw → tracked) | 0.0057 → **0.0035** | ≤ 0.004 | PASS |
| 4 Hz, 0.15-palm shake: p95 | **0.050** | ≤ 0.06 | PASS |
| 2.5 palm-widths/s sweep: mean | **0.041** | ≤ 0.06 | PASS |
| Dropout 0.4 s → visible again | **67 ms**, first-frame error ≤ 0.012 | ≤ 200 ms, ≤ 0.05 | PASS |
| Hidden after loss | 167 ms (hold + fade) | — | — |
| Outliers on 10 % of frames: p95 with / without rejection | 0.008 / 0.017 | — | — |

The tests check the temporal acceptance criteria in 2 views. The filter settings were chosen across 4 views × 5 seeds
(all 20 pass).

**What these numbers do NOT include:**
- any error in the reference skeleton itself (the synthetic hand is built from the same table);
- MediaPipe's real landmark bias (it is not just noise);
- skin deformation;
- real latency.

Those can only be measured on real recordings.

## 7. Real-camera validation (how to get real evidence)

Acceptance thresholds for real recordings (fixed now, before any recording):
- median ≤ **0.06** palm widths and p95 ≤ **0.15**;
- ≥ **90 %** of markings within 0.10;
- stationary jitter ≤ **0.01**;
- reacquisition ≤ **0.5 s**;
- ≥ **24 fps**.

1. Make a **validation protocol** with dots on known spots, for example the centre of each finger segment, the palm
   centre and the thenar eminence, in all four views.
2. With a skin-safe pen, draw a small dot on the tester's hand at each of those spots (judge them against the diagram).
3. Open `/protocols/<slug>/camera/<view>?debug=1`, then **Start Camera** and finish calibration. In the developer
   readout's **Validation** panel:
   - set **Lighting**;
   - **Record still (5 s)**: hand held still;
   - **Record movement (10 s)**: move naturally, leave the frame once and come back;
   - **Freeze & label**: click a drawn (cyan-numbered) marking, then click its pen dot, for every marking, on 3–5
     frozen frames in different poses;
   - **Export JSON**.
4. Repeat per view, hand, lighting (bright / indoor / dim) and tester (different hand sizes and skin tones). Keep at
   least one tester's sessions **held out**: do not use them to tune anything.
5. Score: `cd frontend && npm run ar:report -- path/to/*.json`. It prints alignment (overall and per view/lighting),
   jitter, fps, detection time, losses per minute and reacquisition time, each against the thresholds above. It exits 1
   when any check fails.

Optional comparisons on a device (debug only):
- `&palm=affine`
- `&predict=0`
- `&mapping=similarity` (the previous whole-hand fit)

Privacy: exports contain coordinates and timings only. The frozen frame stays in page memory. Nothing is uploaded.

## 8. Reference skeleton maintenance

The 21-point tables are measurements of the drawings. Estimated uncertainty:
- creases and knuckle lines: ±0.01 of the image;
- MCPs and tips: ±0.02;
- thumb CMC (least certain): ±0.04.

`/admin/hand-reference` (admin only):
1. Drag points and **Preview on this device**. The camera on that device uses the edited skeleton; the debug readout
   says "LOCAL reference override in use".
2. **Download JSON**.
3. An engineer replaces `BUILT_IN_REFERENCE_LANDMARKS`, then runs `npm test` and `npm run ar:benchmark`.

Doctors can pin a marking to a region in the Studio's **Camera anchor** control. It is stored in the existing
`landmarkReference` field, so there is no schema or API change, and undo/redo works. Automatic anchors that fall between
regions are flagged instead of guessed. A pinned marking that was later dragged elsewhere is flagged too. Existing
protocols need no migration: automatic anchors are computed from saved positions at runtime.

## 9. Known limitations

- **No real-camera accuracy has been measured.** Synthetic results are an upper bound on what the geometry allows.
- **2D only.** Strong flexion towards the camera foreshortens a finger. Reliability then fades those markings rather
  than placing them with false precision. Beyond the "natural" range (> 25° per joint, > 20° tilt), accuracy drops (the
  hard row in section 6).
- **Skin is not rigid.** Markings on joint creases move with skin folding that a bone model does not represent.
- **Palm vs back of hand** cannot be detected geometrically (section 5).
- **Thumb CMC** in the reference is the least certain point, and is down-weighted.
- **Forward prediction** was tuned on synthetic data with zero render latency. Verify on devices.
- Detection cost of the real MediaPipe model was not measured here (the CDN is blocked in the build environment). The
  mapping and tracking add ≈ 0.1 ms per frame.

## 10. Remaining work to meet the real-world acceptance thresholds

1. Collect the real validation sessions in section 7 (≥ 3 testers, all 4 views, 3 lighting conditions, one held out).
2. If the median error shows a **consistent offset per landmark**, refine the reference skeleton with
   `/admin/hand-reference` using the validation data. Re-measure on the held-out tester only.
3. If shake or lag fails on devices, re-tune `predictMs` / `minCutoff` / `beta` against the recordings, not the
   synthetic benchmark.
4. Record which device and browser combinations reach 24 fps.
