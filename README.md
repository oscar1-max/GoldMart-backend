# GoldMart backend

Express / PostgreSQL marketplace API. Node 22+ is required.

## Setup and checks

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and supply private settings locally or in Render.
3. Run `npm run migrate` to apply additive schema setup, then `npm start`.
4. Run `npm test` for isolated PostgreSQL-compatible integration tests (PGlite).

Startup also runs schema setup transactionally before accepting requests. Failure aborts startup rather than serving a partially initialized database. Existing records are preserved. Take a database backup before a production rollout. `/api/health` now checks database connectivity.

## Payments and fulfillment

Only Paystack **test** keys are accepted. Live payments, live refunds and seller transfers are disabled. A browser verification and signed webhook use the same idempotent order finalizer. Multi-seller shipments progress separately; the buyer order becomes delivered only after all seller shipments are delivered. Recorded allocations are not withdrawable balances or escrow.

Set `FRONTEND_URL` to the actual frontend origin. Configure Paystack's test webhook as `https://YOUR-BACKEND/api/payments/webhook` and set `ENABLE_PAYSTACK_WEBHOOKS_TEST=true` after configuring a test key. Test refunds additionally require `ENABLE_PAYSTACK_REFUNDS_TEST=true` and an authorized `ADMIN_USER_ID`.

USD product totals are converted to NGN using the explicitly configured `USD_TO_NGN_RATE`; it is not a live exchange-rate feed. NGN catalog records retain their denomination. New listings support USD and NGN, the checkout-supported currencies.

## Owner actions before real-money launch

- Verify Render environment values and database backup/restore access.
- Run a real Paystack test checkout and verify callback, webhook and refund records in the provider dashboard.
- Configure Resend sender/domain and API key for email verification, if wanted.
- Confirm a marketplace seller settlement arrangement, recipient verification, commission and refund responsibilities with the provider. There is no automatic seller transfer implementation in this release.
- Only then plan and review a separate live-payment release. Merely replacing the key with a live key will intentionally block checkout.

## Validation limits

Integration tests simulate Paystack; they do not prove provider credentials, settlement or Render configuration. PGlite tests run serially and do not replace production PostgreSQL concurrency/load testing. If stock disappears after payment initialization, order finalization refuses partial fulfillment and requires support reconciliation. Stock reservation before provider checkout remains a launch follow-up.
