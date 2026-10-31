# Protocol access and payments — Phase 1 (free launch, payment-ready)

**At launch, every published protocol is free. No payment is collected, no payment provider is connected, and the system
does not charge anyone.** What exists is the *architecture* that lets paid access be added later without redesigning
the product.

## What visitors see

On a protocol's page (`/protocols/:slug`) a visitor first sees **Get Your Protocol**:

* "Free during launch" and "Normally, access to this protocol will be available through secure online payment. For now,
  protocols are completely free — no payment required."
* Two clearly separate blocks — **FREE NOW** ("No payment is required right now.") and **Secure online payment**
  ("Payment will be introduced in a future release."). No price is shown or promised.
* The button **Get Protocol — Free Now**. After it: **Free access activated** / "Protocol unlocked — free during launch",
  and the protocol (markings, PDF, share) appears.

The wording is deliberately never "Payment successful", "Paid" or "Transaction completed": nothing was paid.
The page is not a payment page — it has no inputs for card, UPI or bank details.

The flow works with or without an account. A signed-in user's id is linked to the access record; an account is never required.
The browser remembers only an opaque access id per protocol (localStorage, optional); the backend re-validates it on every
visit, so editing it unlocks nothing. If the access service is unreachable or switched off, the protocol is simply shown —
visitors are never locked out by it.

## Modes

`payment_settings.mode` (one row, `FREE` by default):

| Mode | Behaviour |
| --- | --- |
| `FREE` (launch) | No gateway call. A `free` access record is stored (amount 0). Immediate unlock. |
| `PAID` (future) | Needs **all three**: a registered + configured payment provider, the existing `PAYMENTS` feature flag ON, and a configured amount. Otherwise checkout is refused (HTTP 503, *"Paid checkout is not configured yet. Protocols remain available for free during the launch period."*) and **no order and no access is created**. With a provider, an order is created as `pending` and unlocks **only after the provider verifies payment**. |

An administrator can switch FREE/PAID at `/admin/payments`. In this release switching to PAID changes nothing a visitor pays,
because no provider exists. The existing `PAYMENTS` flag keeps its launch value (OFF); it is the extra safety latch for real charging.

## Backend

* Migration `007_payment_access` (additive; migrations 001–006 untouched): tables `payment_settings` (single row) and
  `payment_orders` (id, user_id nullable, protocol_id, protocol_version_id, amount_minor, currency, status
  `created|pending|paid|failed|cancelled|free`, mode, provider, provider_order_id, provider_payment_id, provider_reference,
  created_at, updated_at, completed_at). Money is integer minor units (paise). There is no column that could hold card
  numbers, CVV, banking passwords or UPI PINs. PostgreSQL is the only database (amounts are BIGINT minor units).
* `src/payments/paymentService.js` — all decisions. `src/payments/providers/` — the boundary: `PaymentProvider.js`
  (`createOrder / verifyPayment / getOrderStatus`), `freeProvider.js` (no key, no SDK, no network), `registry.js`
  (real providers register here; none ship in Phase 1).
* Routes (`public.payments.routes.js`, mounted at `/api/public`; gated by the WEBSITE and PROTOCOL_BROWSER flags like the rest of the public API):

| Method & path | Purpose |
| --- | --- |
| `GET /api/public/payment/status` | `{ accessEnabled, mode, free, canCheckout, price, message }` |
| `POST /api/public/protocols/:slug/access` | Ask the backend to unlock a **published** protocol. Body optional: `{ accessId }` (idempotent retry). Anything else in the body is ignored. 201 `{ accessId, status, mode, unlocked, protocol:{slug,name}, message }`; 404 for draft / in-review / archived / unknown (identical response); 503 when access is off or PAID is not configured |
| `GET /api/public/access/:accessId` | Re-check a record; `unlocked` is recomputed from the protocol's *current* published state (an archived protocol stops unlocking) |
| `POST /api/public/access/:accessId/verify` | PAID only: the provider confirms payment. 503 until a provider is configured |

  Admin (`admin.payments.routes.js`; admin only — anonymous 401, doctor/patient 403; also needs the ADMIN flag):
  `GET /api/admin/payments/settings`, `POST /api/admin/payments/settings` with any of `{ mode, accessEnabled, futureAmount, currency }`
  (validated; a provider cannot be chosen from the API in Phase 1).

## Security decisions

* The server alone decides. The request's amount, "paid", "unlocked", mode or provider are never read.
* A provider can never create an already-`paid` order; `paid` is set only from a provider's `verifyPayment` result.
* Provider text is length-capped before storing; the verification evidence (anything the browser sends) is passed to the provider and never stored.
* Responses never include provider names, provider ids, signatures or settings internals. Provider errors become a generic 502.
* No payment SDK, key, secret or external request exists in the code (a test scans for it).
* Responses are `Cache-Control: no-store`.

## Admin page — `/admin/payments`

"Payment Access": current mode (FREE), launch message ("Protocols are currently free."), future amount (₹____, stored only),
currency (INR), future provider ("Not configured"), actual charging (OFF), and controls to switch FREE/PAID, save the future
amount and hide/show the access step. Doctors and patients cannot reach it.

## Becoming paid later (not done now)

1. Add a provider file under `src/payments/providers/` implementing the three methods, and register it in `registry.js`
   (its credentials come from backend environment variables only).
2. Allow selecting it in the admin settings, set an amount, switch the `PAYMENTS` flag on, switch the mode to PAID.
3. Add the provider's browser checkout step to the Get Your Protocol panel; the browser hands the provider's evidence to
   `POST /access/:id/verify`. Add webhooks if the provider needs them. Add gating of the render/PDF endpoints on a verified
   access record.

## Known limitations

* In Phase 1 the access step is a **flow**, not a security boundary: `GET /api/public/protocols/:slug/render` and the other
  public reads stay open (nothing is charged, so there is nothing to protect). Enforcement belongs with step 3 above.
* No rate limiting exists in the app; `POST …/access` stores one small row per call (use the `accessId` retry for idempotency).
* The browser's remembered access id is per-browser; a different device simply taps the button again.
