# ProofCast example — task list

A tiny, **zero-dependency** task list (Node's built-in `http` server only). It is
the *plain feature* entry in the README's
[See it work](../../README.md#see-it-work) gallery, and the one that matters most
for the general case: **there is no password and no card here** — just a text
field and an *Add task* button.

That is the point. Signup and checkout are recognisable by their credential
fields; this one is only recognisable as "a form with a submit control", which is
the shape most real features actually have — todo lists, contact forms, comment
boxes, search-and-add.

From the repository root:

```bash
npx proofcast run ./examples/todo
```

ProofCast boots the app, drives it in a real Chromium (types a task, clicks *Add
task*, and watches the list actually grow — the item appears, the empty state
disappears, and the counter goes from "0 tasks" to "1 open · 1 total"), records
the session, transcodes it to MP4, and prints one line of JSON on stdout:

```json
{ "success": true, "proofPath": ".../examples/todo/proofcast-proof.mp4", "durationMs": 3380 }
```

The exit code is `0` on a passing proof, non-zero otherwise. The list starts
genuinely empty on every boot, so a recorded item can only be there because
ProofCast put it there.
