# ProofCast example — checkout

A tiny, **zero-dependency** product page with a real card-payment form (Node's
built-in `http` server only). It is the *payment* entry in the README's
[See it work](../../README.md#see-it-work) gallery — and the example bundled
inside the published package, so it is what `proofcast demo` proves from any empty
folder.

From the repository root:

```bash
npx proofcast run ./examples/checkout
```

…or, from **anywhere at all** (this example ships inside the package, so no clone
and no files of your own are needed):

```bash
npx proofcast demo --share
```

ProofCast boots the app, drives it in a real Chromium (types the universally
recognised test card `4242 4242 4242 4242`, a name, an expiry and a CVC, clicks
*Pay $149.00*, then waits out the deliberately async payment until it settles on
"Payment successful" with a fresh order number), records the session, transcodes
it to MP4, and prints one line of JSON on stdout:

```json
{ "success": true, "proofPath": ".../examples/checkout/proofcast-proof.mp4", "durationMs": 3360 }
```

The exit code is `0` on a passing proof, non-zero otherwise. Nothing here is faked
on page load — the success state only exists because the form was actually driven.

> The form uses the standard `autocomplete` tokens (`cc-number` / `cc-exp` /
> `cc-csc`), which is exactly how ProofCast's generic demo driver recognises a
> checkout — the same way it would on a real payment page.
