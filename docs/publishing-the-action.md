# Publishing the ProofCast GitHub Action

Everything here is **manual and yours to do** — it needs an interactive, logged-in
GitHub session. Nothing in this repo publishes on its own.

There are two independent artifacts, and they release **independently**:

| Artifact | Where it lives | Who consumes it |
| :-- | :-- | :-- |
| `proofcast` npm package | npmjs.com | people running the CLI locally (`npx proofcast …`) |
| ProofCast **Action** | a git **tag** in this repo, listed on the Marketplace | `uses: guillaumeCode2012/proofcast@v1` |

**The action does not depend on the npm release.** It is self-contained: `version`
defaults to `bundled`, which runs the ProofCast checked out with the action at the ref
the workflow pinned. So `@v1` ships the ProofCast from `v1`, by construction — the
prover can never drift from the reporter, and a tag is enough to make the action work
for everyone. Publishing to npm is worth doing for CLI users, but it is not a gate.

---

## 1. Tag the action

The Marketplace lists a **tag**, and consumers pin a major version. Ship a precise
tag and move the floating major tag onto it:

```bash
git tag -a v0.5.0 -m "ProofCast Action v0.5.0"
git push origin v0.5.0

# the moving major tag users actually reference
git tag -f v1 v0.5.0
git push -f origin v1
```

> `v1` is intentionally force-moved on each release — that is the convention every
> published action follows, and it is why `uses: …@v1` keeps working.

## 2. Create the release + list it

1. Open **<https://github.com/guillaumeCode2012/proofcast/releases/new>**.
2. Pick the tag **`v0.5.0`**.
3. GitHub detects `action.yml` at the repo root and shows a banner:
   **"Publish this Action to the GitHub Marketplace"** — tick it.
   - If the banner is missing, check that `action.yml` is at the **repository root**
     and has `name`, `description`, and `branding` (icon + color). `npm test`
     asserts all three, so a green suite means the manifest is listable.
4. Accept the **GitHub Marketplace Developer Agreement** (once per account).
5. Choose categories — **Continuous integration** as primary, **Testing** as secondary.
6. The action's `name:` must be **globally unique across the Marketplace**. If
   "ProofCast" is taken, change `name:` in `action.yml`, commit, and re-tag.
7. Write the release notes, then **Publish release**.

## 3. Verify it from the outside

The only test that counts is a repository that is not this one:

```yaml
- uses: guillaumeCode2012/proofcast@v1
  with:
    path: .
```

Open a PR there and confirm you get the comment, the artifact, and the
`proofcast/proof` check.

---

## Republishing (every subsequent release)

```bash
# 1. bump
npm version patch          # or minor / major
#    keep src/index.ts's PROOFCAST_VERSION in sync — `npm test` fails if it drifts

# 2. tag — this alone ships the action
npm test
VERSION="v$(node -p "require('./package.json').version")"
git push origin main
git tag -a "$VERSION" -m "ProofCast Action $VERSION" && git push origin "$VERSION"
git tag -f v1 "$VERSION" && git push -f origin v1

# 3. npm, whenever you like — for CLI users, not for the action
npm publish
```

Then edit the GitHub Release for the new tag. A release already listed on the
Marketplace stays listed — you do not repeat the listing flow.

## Un-publishing

Marketplace → the action's page → **Delist**. The tag and the npm package are
unaffected; `uses:` keeps resolving for anyone already referencing it.
