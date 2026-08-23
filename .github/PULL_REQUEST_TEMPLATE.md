## Summary

<!-- One or two sentences: what does this PR change and why? -->

## Motivation

Fixes #
<!-- or: Related to # -->

## Changes

-
-

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm test` passes; new/changed behavior is covered by tests
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] README / docs updated for any behavior, flag, or default change
- [ ] CLI surface changed? → `src/completions.ts` completion tables updated (flag-drift test enforces this)
- [ ] Persisted index formats touched? → `schemaVersion` handled, backward-compatible, loader validation + tests added
- [ ] No new runtime dependencies (or justified in the description)
