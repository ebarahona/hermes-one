## Summary

<!-- What changed and why. -->

## Checklist

- [ ] `pnpm -r build && pnpm verify` passes (typecheck, plane-lint, unit tests)
- [ ] `pnpm lint` passes
- [ ] `pnpm test:itest` passes, if persistence, RLS, or routes changed
- [ ] Replay gate passes, if workflow or interpreter code changed (ADR-029)
- [ ] Plane boundaries respected (ADR-017); I/O only in `infrastructure/` (ADR-024)
- [ ] New tenant tables have row-level security policies
- [ ] Intentional gaps recorded in `docs/DEFERRED-AND-FLAGGED.md`
- [ ] Conventional Commit messages
- [ ] DCO sign-off on every commit (`git commit -s`)
