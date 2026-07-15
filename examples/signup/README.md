# ProofCast example — signup

A tiny, **zero-dependency** signup page (Node's built-in `http` server only). It
exists so you can watch ProofCast produce a **real video proof** on real code in
about two minutes — with **no API key, no Telegram, no Vercel**.

From the repository root:

```bash
npm run demo
# …which is exactly:
npx proofcast run ./examples/signup
```

ProofCast boots this app, drives the signup form in a real Chromium (types an
email + password, submits, sees "Account created for …"), records the session,
transcodes it to MP4, and prints one line of JSON on stdout:

```json
{ "success": true, "proofPath": ".../examples/signup/proofcast-proof.mp4", "durationMs": 1234 }
```

The exit code is `0` on a passing proof, non-zero otherwise — so you can script on
it. The MP4 lands right next to this README (git-ignored).

> `proofcast run` is the **pure prover**: it only proves code that already
> exists and makes no AI call, so this trial needs no provider key. Generating a
> feature (`proofcast generate`) or shipping it (Telegram `Déploie`) is the
> configured path — see the repository [README](../../README.md).
