# Phase 2 — Patient Camera + Hand Landmark AR

**Status: Steps 1–5 only, as instructed.** Nothing from Step 6 onward
(left/right identification, orientation, calibration, protocol→landmark
mapping, the AR overlay itself, smoothing, tracking-confidence handling, or
session recording) has been built yet. This is intentional — the brief was
explicit: verify Steps 1–5 before building the mapping/AR system.

Phase 1's Protocol Builder was **not** touched except for one small, additive
change (see §6). The hand assets, the normalized coordinate system, and the
protocol object model are all exactly as they were.

## 1. What was built

- **Step 1 — Patient auth foundation.** A new `POST /api/auth/patient/activate`
  endpoint lets a patient turn the "pending" invite a doctor created (via
  Assign in the builder) into a real login. `ProtectedRoute` already
  supported a generic `role` prop from Phase 1, so patient routes just use
  `role="patient"` the same way doctor routes use `role="doctor"`.
- **Step 2 — Patient dashboard** (`/patient/dashboard`). Lists protocols
  assigned to the logged-in patient via a new, read-only
  `GET /api/patient/protocols` endpoint. A protocol only shows as
  "Open"-able once the doctor has set it to **Active** (see §6).
- **Step 3 — Protocol selection/loading** (`/patient/protocols/:id`). Loads
  the full protocol read-only via `GET /api/patient/protocols/:id`, which
  reuses the exact same serializer the doctor's builder uses — same object
  model, same normalized coordinates, no second data format. The patient
  picks which saved view (Left Front, Right Front, etc.) they're about to
  show the camera — see §8 for why this is a deliberate stand-in for
  automatic orientation detection, not a shortcut.
- **Step 4 — Camera permission + preview** (`useCamera` hook). Requests the
  rear/environment camera first, falls back to whatever's available, and
  turns every `getUserMedia` failure mode into a specific, human-readable
  message (permission denied, no camera, insecure context, unsupported
  browser, camera busy) instead of crashing.
- **Step 5 — Hand landmark detection only** (`useHandLandmarker` hook +
  `drawHandLandmarks`). Runs MediaPipe's HandLandmarker against the live
  video feed and draws the raw 21-point skeleton + a handedness label as a
  dev-mode overlay, with a small debug readout (landmark count, FPS). This
  is explicitly **not** the AR overlay — no protocol object is mapped onto
  anything yet.

## 2–3. Hand-tracking technology selected, and why

**Selected: `@mediapipe/tasks-vision`'s `HandLandmarker`.**

The existing frontend dependencies (inspected before choosing anything) are
React, `react-konva`/Konva, Zustand, `react-router-dom`, `axios` — no
existing ML/vision library, so this was a free choice. Options considered:

| Option | Verdict |
|---|---|
| **MediaPipe Tasks Vision (`HandLandmarker`)** | **Chosen.** Runs entirely client-side via WebAssembly; a purpose-built `VIDEO` running mode designed for exactly this (a continuous webcam stream with monotonic timestamps); returns 21 landmarks per hand *and* a handedness classification in one pass — directly matching every landmark the spec asks for (wrist, all five fingers, every joint, palm) with no extra model. |
| TensorFlow.js `hand-pose-detection` (MediaPipe Hands backend) | Viable alternative, same client-side principle, but is a wrapper around an older/deprecated MediaPipe JS API; Tasks Vision is Google's current recommended path. |
| Server-side detection (upload frames to backend) | Rejected outright — the spec requires client-side processing specifically so camera frames never need to leave the device; this also better serves latency and privacy. |

This satisfies the "no frame upload" requirement **by construction**: there
is no code path in this build that sends a video frame anywhere. Everything
happens in the browser.

## 4. Files created/changed

**Backend**
- `src/routes/patient.routes.js` — new. Read-only, ownership-checked
  (`WHERE patient_id = ?` on every query — not just a client-side check)
  protocol list/detail for the logged-in patient.
- `src/routes/auth.routes.js` — added `POST /patient/activate`.
- `src/server.js` — mounted the new patient routes at `/api/patient`.

**Frontend**
- `src/camera/useCamera.js` — new. Camera permission/stream lifecycle.
- `src/tracking/useHandLandmarker.js` — new. Loads and calls HandLandmarker.
- `src/tracking/drawHandLandmarks.js` — new. Dev-mode skeleton drawing.
- `src/pages/patient/*.jsx` — new. `PatientActivatePage`, `PatientDashboardPage`,
  `PatientProtocolPage`, `CameraSessionPage`.
- `src/pages/LoginPage.jsx` — now redirects by role after login, and links
  to the patient activation page.
- `src/App.jsx` — added the patient routes; root redirect is now role-aware.
- `src/styles/app.css` — added patient/camera page styles.
- `package.json` — added `@mediapipe/tasks-vision` (pinned to `0.10.14` —
  see the comment in `useHandLandmarker.js` for why the version is pinned
  exactly rather than with a caret range: the WASM binary loaded from a CDN
  URL has to match the JS API version, or you get confusing runtime errors).

## 5. How protocol data maps to landmarks

**It doesn't yet — that's Step 7, not built.** What exists right now is only
the raw detection output (21 normalized landmarks + a handedness label)
drawn straight onto a debug canvas. No protocol object has touched a
landmark. This is deliberate: the brief's own "critical development rule"
is to prove landmark detection works on its own before building any mapping.

## 6. One small, additive fix to the Phase 1 builder

The doctor's Builder always displayed a protocol's status but had no way to
*change* it — `PUT /api/protocols/:id` already accepted a `status` field
(Phase 1 backend), but nothing in the UI called it. Since a patient must
only be able to start a protocol the doctor has actually finished and
activated, I added a status `<select>` (Draft / Active / Archived) next to
the existing status badge in the builder's settings bar. This is a two-way
data-binding addition to an existing control, not a rebuild of anything.

## 7. Smoothing / 8. Tracking loss

Not built yet (Steps 11–12). Right now, `CameraSessionPage` shows
"Please place your hand in view" whenever `result.landmarks.length === 0`
for the current frame — that's the full extent of "loss handling" today, and
it's frame-by-frame with no hysteresis. A real implementation needs a
confidence/hysteresis window (the spec's own `TrackingConfidence` module)
so a single dropped frame doesn't flicker the UI — explicitly deferred.

## 9. Left/right and front/back handling

**Left/right:** HandLandmarker's `handedness` output is displayed as a raw
label in the dev overlay, but nothing gates on it yet (Step 6 — verifying
the detected hand matches the protocol's expected hand — isn't built).

**Front/back:** Not detected at all yet. Per the spec's own guidance
("If automatic front/back detection is unreliable, use a controlled user
interaction rather than guessing"), `PatientProtocolPage` has the patient
explicitly pick which saved view they're about to show before the camera
even opens. This isn't a placeholder to be embarrassed about — it may well
be the final answer for this step, or Step 7 may replace it with an
in-camera prompt; either way it satisfies "don't silently guess" today.

## 10. Known limitations (read before treating this as done)

- **Patient account activation has no real identity verification.** Typing
  an email that has a pending invite is enough to claim that account — no
  emailed token. Fine for local development, **not** fine for real patient
  data. Flagged loudly in both the backend route and the frontend page.
- **I could not run any of this.** Same constraint as Phase 1: this sandbox
  has no network access to npm's registry (confirmed blocked,
  `host_not_allowed`) or to the internet generally, so I could not
  `npm install`, could not open a real browser, could not grant a camera
  permission, and could not verify that `@mediapipe/tasks-vision@0.10.14`
  actually loads and runs as expected. What I *did* do:
  - Ran every new/changed `.js`/`.jsx` file through esbuild in
    transform-only mode (full JS/JSX syntax parsing) — all pass.
  - Traced the camera-attach code path by hand and found a real bug (the
    stream was being attached to `videoRef.current` before the `<video>`
    element existed in the DOM, because attachment happened in the same
    function that flips the state gating that element's render) — fixed by
    moving the attachment into a `useEffect` keyed on `status`, which is
    guaranteed to run after the element is mounted.
  - Traced the animation-frame loop's dependency wiring and fixed an
    unnecessary teardown/reschedule churn (a `useCallback` depended on a
    fresh object literal every render instead of the one stable function
    inside it).
  - Verified every ownership check on the new patient routes is enforced in
    SQL (`WHERE patient_id = ?`), not just in the UI.

  I have **not** watched the camera preview actually show a picture, and I
  have **not** watched a real hand get detected. Please treat §12 (exact
  testing steps) as the actual first real test of this code, the same way
  I asked you to treat Phase 1's acceptance walkthrough that way.

## 11. Exact steps to run

Same two-terminal setup as Phase 1 (`README.md` §2), plus one thing: **the
model file is fetched from Google's CDN at runtime** the first time the
camera page loads (`https://storage.googleapis.com/mediapipe-models/...`),
so the machine running the frontend needs internet access for that one
request. It's a few MB; after the first load the browser will typically
have it cached.

```bash
# Terminal 1
cd backend && npm install && npm run dev

# Terminal 2
cd frontend && npm install && npm run dev
```

Then, as a doctor:
1. Log in, create (or open) a hand protocol, place at least one object.
2. In the settings bar, change **Status** from Draft to **Active**.
3. Assign it to a patient by email (e.g. `patient@example.com`).

Then, as the patient:
4. Log out, go to `/patient/activate`, enter that same email and a password.
5. You're now on `/patient/dashboard` — the protocol should show as
   "Open"-able.
6. Open it, pick a view, click **Start Camera**, allow the permission
   prompt. You should see your own camera feed with a live skeleton drawn
   over your hand once one is in frame, plus a "Hand detected ✓ (Left/Right)"
   badge and a small FPS/landmark-count readout.

## 12. Exact steps to test on a real phone

A phone is not "localhost", and browsers require a secure context for
camera access on anything that isn't `localhost` — so testing over your
LAN needs HTTPS, which needs a certificate. The reliable way to do this
locally (recommended over guessing at a Vite plugin's current API, which I
can't verify works in this sandbox):

1. Install [`mkcert`](https://github.com/FiloSottile/mkcert) on your
   machine (e.g. `brew install mkcert` / see its README for other OSes),
   then run `mkcert -install` once.
2. Find your machine's LAN IP (e.g. `192.168.1.23` — `ifconfig`/`ipconfig`).
3. In the `frontend/` folder: `mkcert 192.168.1.23 localhost` — this creates
   two files, e.g. `192.168.1.23+1.pem` and `192.168.1.23+1-key.pem`.
4. In `frontend/vite.config.js`, add to the `server` block:
   ```js
   import fs from 'fs';
   // ...
   server: {
     port: 5173,
     host: true,
     https: {
       cert: fs.readFileSync('./192.168.1.23+1.pem'),
       key: fs.readFileSync('./192.168.1.23+1-key.pem'),
     },
   },
   ```
   (adjust the filenames to whatever `mkcert` actually generated).
5. Also update `frontend/.env`'s `VITE_API_URL` to
   `https://192.168.1.23:4000` and give the backend its own cert the same
   way (or, simpler for a first test, run the backend as plain HTTP on the
   same LAN and add `192.168.1.23:4000` — some browsers allow a secure page
   to call plain HTTP on a private LAN address; if yours blocks it, put the
   backend behind HTTPS the same way as the frontend).
6. Run `npm run dev` in both terminals, then on your phone (same Wi-Fi
   network) visit `https://192.168.1.23:5173`. Accept the certificate
   warning (mkcert's root CA isn't installed on the phone, only on your
   dev machine, so the phone will still flag it as untrusted — proceed
   anyway for local testing).
7. Log in as the patient, open the protocol, tap **Start Camera**, and
   allow the permission prompt.

## 13. Blockers before continuing to Step 6+

None structural. The one open decision worth flagging before Step 6: the
patient-activation security gap in §10 should probably be closed (or
explicitly accepted as a demo-only limitation) before this goes anywhere
near real patient data — it doesn't block continuing the AR work itself.
