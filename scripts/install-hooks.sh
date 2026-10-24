#!/bin/sh
# Auto-runs from `pnpm install` via the root `prepare` script.
#
# Installs this repo's lefthook hooks into THIS clone's own `.git/hooks`
# and nowhere else. It never modifies your git config (local or global)
# and never writes into a hooks directory that config points at outside
# this repo. It exits 0 without installing anything when:
#
#   - running on CI;
#   - this directory is not the root of its own git work tree (e.g. it
#     was unpacked from a tarball, or lives under `node_modules`);
#   - `core.hooksPath` is set (globally or locally) to anything other
#     than this repo's own `.git/hooks`. In that case lefthook would
#     install its shims into that directory and rename your existing
#     hooks to `*.old`, so opt-in instructions are printed instead.
#
# CI runs lint, build, and tests on every pull request regardless of
# local hooks, so skipping the local install is safe -- just slower
# feedback.

# Skip entirely on CI: no need to install git hooks in an ephemeral
# runner, and lefthook's platform-specific binary may not be available
# on every runner.
if [ -n "$CI" ]; then
  exit 0
fi

print_opt_in() {
  cat <<'EOF' >&2

----------------------------------------------------------------------
note: this repo's git hooks were NOT installed automatically.

This usually means you have a `core.hooksPath` configured globally
(e.g. by your dotfiles or your employer). We did NOT change your git
config -- your existing hooks are untouched.

If you'd like this repo's lint/format/commitlint hooks to fire in
addition, opt in locally. Both options affect THIS clone only and can
be reversed with `git config --local --unset core.hooksPath`.

  # Lefthook path (parallel, staged-files-aware):
  git config --local core.hooksPath .git/hooks
  pnpm exec lefthook install --force

  # Zero-dependency fallback (sequential, whole-tree, no lefthook needed):
  git config --local core.hooksPath .githooks

Either one shadows your global hooks for this clone only. Pick the
trade-off you prefer.
----------------------------------------------------------------------

EOF
}

# Resolve the repository root (the directory above scripts/) physically.
pkg_root=$(cd "$(dirname "$0")/.." && pwd -P) || exit 0

# Never touch a repository this checkout is merely installed into.
case "$pkg_root/" in
  */node_modules/*)
    exit 0
    ;;
esac

# Skip unless this directory is the root of its own git work tree.
toplevel=$(git -C "$pkg_root" rev-parse --show-toplevel 2>/dev/null) || exit 0
toplevel=$(cd "$toplevel" 2>/dev/null && pwd -P) || exit 0
if [ "$toplevel" != "$pkg_root" ]; then
  exit 0
fi

# Refuse to install when core.hooksPath (effective value, local or
# global) points anywhere other than this repo's own .git/hooks.
# lefthook installs into whatever hooksPath resolves to, and renames
# the hooks it finds there to *.old.
hooks_path=$(git -C "$pkg_root" config --path core.hooksPath 2>/dev/null)
if [ -n "$hooks_path" ]; then
  git_common_dir=$(git -C "$pkg_root" rev-parse --git-common-dir 2>/dev/null) || exit 0
  case "$git_common_dir" in
    /*) ;;
    *) git_common_dir="$pkg_root/$git_common_dir" ;;
  esac
  own_hooks=$(cd "$git_common_dir/hooks" 2>/dev/null && pwd -P)
  case "$hooks_path" in
    /*) ;;
    *) hooks_path="$pkg_root/$hooks_path" ;;
  esac
  resolved=$(cd "$hooks_path" 2>/dev/null && pwd -P)
  if [ -z "$own_hooks" ] || [ "$resolved" != "$own_hooks" ]; then
    print_opt_in
    exit 0
  fi
fi

if pnpm exec lefthook install; then
  exit 0
fi

print_opt_in
exit 0
