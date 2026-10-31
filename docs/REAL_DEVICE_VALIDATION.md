# Real-device validation (what automated tests can NOT prove)

`npm test` runs **deterministic software tests**: they check maths, data handling and server
behaviour. They cannot tell you whether the AR overlay lands on a real person's hand, because that
depends on the camera, lighting, MediaPipe's live output and the physical hand. Only a person with a
device can validate that. This file keeps the two kinds of evidence separate.

## What the automated tests DO cover (AR-related)
- The similarity-transform maths, pixel-space fitting (including a regression test for the aspect-ratio bug
  found on a real device), dot/ring mapping for all four views, the object-fit:cover mapping, the geometric
  left/right-hand gate, and the drawing calls — all against synthetic input.
- The `object-fit:cover` test reproduces the exact numbers you read off your device's debug panel
  (1280×720 video in a 1466×825 canvas → scale 1.1458, offset x ≈ −0.3).

## Real-device status — as REPORTED by the project owner (not re-verified by the developer of this file)

| Item | Status | Source |
|---|---|---|
| Left hand detected as Left (Step 6, v3 build) | Passed | owner report |
| Right hand detected as Right | Passed | owner report |
| Wrong hand is blocked | Passed | owner report |
| Dot follows hand movement | Passed | owner report |
| Dot follows rotation (visual) | Passed | owner report |
| Dot follows distance/scale change (visual) | Passed | owner report |
| Hand removal and re-entry | Passed | owner report |
| Ring/circle overlay (Step 7) on a real hand | **Not yet reported** | — |
| Skeleton mapping (21 landmarks, per-finger), calibration step, tracker hold/fade, perspective palm | **Not yet measured on a real device.** Synthetic results and the measurement procedure: docs/HAND_AR_ACCURACY.md | developer |
| Public Camera route (`/protocols/:slug/camera/:viewKey`), smoothing, layering, view/protocol switching | **Not yet reported** on a real device. Verified only in headless Chromium with a fake camera and a synthetic hand (see docs/CAMERA_AR.md) | developer |
| Views other than the one tested (Right Front, Left Back, Right Back) | **Not reported** | — |
| Small residual dot offset seen earlier on the pre-v3 build | **Unresolved**: the numeric v3 debug-panel readout was never supplied, so no root cause was established | — |
| Different phones/cameras, front vs rear camera, low light, other skin tones/hand sizes | **Not reported** | — |
| Long-session performance / battery (only "FPS ≈ 20" seen on one laptop) | **Not reported** | — |

## Checklist to repeat on a device after any change to `tracking/`, `camera/` or the reference tables
Switch the camera on at `/admin/camera`, open a published protocol's page (`/protocols/:slug`) → **Camera** → **Start Camera**
(the legacy patient page `/patient/protocols/:id` uses the same camera code) → for **each** of the four views:
1. Correct hand shown → banner says "Hand detected ✓"; wrong hand → blocked.
2. Dot (and ring, if the protocol has one) sits on the same anatomical spot as in the Builder.
3. Move the hand left/right/up/down, closer/farther, rotate it; the marking stays on the same spot.
4. Take the hand out of frame and bring it back.
5. Stop Camera / Exit / browser Back: the camera indicator turns off.
6. Open a second protocol: only its own markings appear.
6b. Calibration: the banner asks for a flat hand, fills its progress bar, then the markings appear. Bend one finger slowly: its markings follow, then fade when it curls.
6c. Collect labelled validation sessions (`?debug=1` → Validation) and score them with `npm run ar:report` — docs/HAND_AR_ACCURACY.md §7.
7. Note the device, browser, lighting, and any offset (a screenshot of the debug panel with the
   "— Dot coordinate trace —" section is the most useful evidence — on the public camera add `?debug=1` to the address).

Do not describe AR accuracy in any user-facing text until items marked "Not reported" have been checked.
