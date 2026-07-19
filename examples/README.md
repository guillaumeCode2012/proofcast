# ProofCast examples

Three small, **real, self-contained apps** — one per shape ProofCast has to be
able to prove. Each is zero-dependency (Node's built-in `http` server only), boots
in a second, pulls nothing from the network, and runs identically on macOS, Linux
and Windows.

| Example | Shape | What the proof shows | Command |
| --- | --- | --- | --- |
| [signup](signup) | auth (password) | the account is created | `npx proofcast run ./examples/signup` |
| [checkout](checkout) | payment (card) | the payment goes through | `npx proofcast run ./examples/checkout` |
| [todo](todo) | plain CRUD (no credentials) | the task lands in the list | `npx proofcast run ./examples/todo` |

Each run records a real MP4 next to the example (git-ignored), prints one JSON
line on stdout, and exits `0` only if the proof passed. The recordings are in the
README's [See it work](../README.md#see-it-work) gallery.

`proofcast run` is the **pure prover**: it only proves code that already exists
and makes no AI call, so none of this needs a provider key.

## Why three

`todo` is the load-bearing one. `signup` and `checkout` carry credential fields
(a password, a card number) that make them trivially recognisable; `todo` has
neither, so it is what keeps ProofCast honest about driving an *ordinary* feature
rather than scrolling past it. All three are asserted in CI (`npm test`).

## Also here

- [github-action](github-action) — a drop-in `proof.yml` workflow that runs
  ProofCast on every pull request.
