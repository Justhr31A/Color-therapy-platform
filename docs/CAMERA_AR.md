# Camera — live AR markings on the visitor's hand

Any visitor can open a **published** protocol, press **Camera**, and see that protocol's exact markings drawn over their
own hand in the live camera picture. No login, no patient assignment, no doctor approval. **Download** is unchanged.

The camera is **OFF by default**. An administrator switches it on at **`/admin/camera`** (Dashboard → *Camera (AR)*), or
locally with `npm run flags -- enable CAMERA` then `npm run flags -- enable AR` in `backend/`.

## How it works

```
/protocols/:slug                     protocol page: Download PDF · Camera · Copy link · Offline copy (HTML)
      │  Camera (shown only while the camera is on and the protocol has a hand view)
      ▼
/protocols/:slug/camera/:viewKey     PublicCameraPage → CameraSessionCore (variant="public")
      │  GET /api/public/camera/status            { enabled }  (WEBSITE + PROTOCOL_BROWSER + CAMERA + AR)
      │  GET /api/public/protocols/:slug/render   the PUBLISHED snapshot — same data as the page and the PDF
      ▼
Start Camera → getUserMedia (rear camera first) → MediaPipe HandLandmarker in the browser (WASM)
      → per frame: tracking/arFrame.js  computeArFrame()
          no hand / two hands / low confidence / wrong hand  → overlay hidden, guidance shown
          otherwise: 6 calibration landmarks (wrist + 5 knuckles, video px)
                     → One-Euro smoothing (tracking/landmarkSmoothing.js)
                     → similarity fit vs the view's reference points (reference px)
                     → every drawable object mapped, in the protocol's zIndex order
      → drawProtocolOverlay on a transparent canvas exactly over the video (object-fit: cover mapping)
```

- **Which protocol / which view:** `camera/publicCameraData.js → cameraSessionFor()` picks the canvas for the slug and
  view in the URL. The session is mounted with `key = slug::viewKey`, so changing protocol or view always starts a fresh
  session — no previous overlay, smoothing state or camera stream carries over. Every frame also starts with a cleared canvas.
- **Access step:** if the free-launch / payment access step applies, the camera page stays closed until it has been
  completed on the protocol page (same rule as Download).
- **Leaving:** Stop Camera, Exit, Back, switching view, browser navigation or closing the page stop every camera track. A
  camera request that finishes after the visitor has already left is released immediately.
- **Developer readout:** hidden from visitors; add `?debug=1` to the camera address to show the hand skeleton and the
  numeric trace. The legacy patient page (`/patient/protocols/:id/session/:viewKey`) still shows it, as before.

## Marking types on the camera

| Type | Drawn | How |
|---|---|---|
| Dot (incl. Dot + Ring, multi-ring, outline) | yes | centre, radius, ring radii/thickness/colours, outline — all scaled with the hand |
| Ring | yes | unfilled circle, radius + stroke scaled |
| Finger band | yes | shared primitives under the hand matrix (position, rotation, scale) |
| Horizontal / vertical line, arrow, free line, triangle, inverted triangle, rectangle, square, text | yes | shared primitives (same as the page/PDF) under the hand matrix; text is flipped back on the mirrored selfie camera so it stays readable |
| Colour, opacity, stroke width, rotation, layer order | yes | layer order = zIndex, ties in saved order (same rule as the page/PDF) |
| Anything unknown | skipped | counted in the camera footnote ("cannot be shown on the camera") |

## Limitations (honest)

- **Mapping is now per anatomical region** (palm + every finger bone, 21 landmarks) with temporal tracking and a
  calibration step — see **`docs/HAND_AR_ACCURACY.md`** for the architecture, the measured (synthetic) accuracy and how to
  measure real-camera accuracy. No real-camera accuracy has been measured yet.
- **Reference skeletons are measurements of the drawings** (`tracking/referenceLandmarks.js`); the thumb CMC is the least
  certain point. Admins can refine them at `/admin/hand-reference`.
- **2D only.** Strong flexion or tilt towards/away from the camera is only partly captured; affected fingers fade.
- **Hand and side are checked together, geometrically.** In 2D a left palm is the mirror image of a right back, so the
  check blocks a wrong hand or a wrong side, but it cannot tell those two apart — and a *right* hand showing its *back*
  passes a *Left Front* view (and so on for each mirror pair). The instruction and the wrong-hand message always name both
  the hand and the side to show.
- Smoothing reduces jitter at the cost of a little lag on very fast moves (offset by a 20 ms forward prediction); it resets on every tracking loss.

## Privacy and security

- Camera frames never leave the device: MediaPipe runs in the browser. Nothing is uploaded, stored or recorded; no
  third-party video service. The microphone is never requested.
- The camera reads only the public, published render contract. Drafts and unpublished edits return 404 there.
- `/api/public/camera/status` returns one boolean. `/api/admin/camera` needs an admin session (doctor 403, anonymous 401)
  and can change only CAMERA and AR.
- Browsers allow the camera only on **https** (or `localhost`).

## Deployment notes

- Both Render services already use https. No new backend environment variables.
- MediaPipe files load from public CDNs: WASM from `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm`, the model
  from `storage.googleapis.com/mediapipe-models/...`. If a network or a Content-Security-Policy blocks them, the camera shows
  "Could not load the hand-tracking engine/model" with a Retry button. To self-host, set `VITE_MEDIAPIPE_WASM_URL` /
  `VITE_HAND_LANDMARKER_MODEL` in the frontend build environment (`frontend/.env.example`). The WASM version must stay 0.10.14.
- The camera switch is stored in PostgreSQL and survives redeploys. Switch it at `/admin/camera`.

## Tests

See also `tests/handSkeleton.test.mjs`, `tests/handTracking.test.mjs`, `tests/arAccuracy.synthetic.test.mjs` and `tests/arTools.render.test.mjs` (skeleton mapping, tracking, calibration, synthetic accuracy gate, Studio anchors, admin reference tool).

- `backend/tests/camera.http.test.js` — switch off by default, admin-only control, public status, anonymous access to
  published protocols, each protocol's own markings, drafts/unpublished edits private, doctor publish still works.
- `frontend/tests/publicCamera.test.mjs` — protocol/view selection and switching, detection states (no hand, two hands, low
  confidence, wrong hand, all four views), exact marking positions/sizes at four resolutions and two distances, shapes and
  bands, layering, smoothing, overlay drawing, camera stream release.
- `frontend/tests/publicCamera.render.test.mjs` — the Camera option next to Download, the camera page states, the admin page.

None of these prove accuracy on a real hand. See `docs/REAL_DEVICE_VALIDATION.md` for the device checklist.
