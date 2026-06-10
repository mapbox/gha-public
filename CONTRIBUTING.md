# Contributing to gha-public

## Overview

This repo contains reusable GitHub Actions workflows for Mapbox public repositories. Workflows here use only public actions — no private dependencies.

## Releasing a new version

Releases use **manual semantic version tags** plus a floating major version tag. No automation — just tag and push.

### Versioning is repo-wide

Tags apply to the entire repo, not individual workflows. There is no per-workflow versioning — `mapbox/gha-public/.github/workflows/workflow-foo.yml@v1` and `workflow-bar.yml@v1` both refer to the same repo tag.

This means a breaking change to **any** workflow is a major bump that requires all consumers (of any workflow in this repo) to update their pins. Be conservative: if you can make a change backwards-compatible, do so.

### Version conventions

| Change type | Example | When to use |
|---|---|---|
| Patch | `v1.0.0` → `v1.0.1` | Bug fix with no interface change to any workflow |
| Minor | `v1.0.0` → `v1.1.0` | New optional input or new workflow added, backwards-compatible |
| Major | `v1.x.x` → `v2.0.0` | Removed or renamed input, changed default behavior, or anything that breaks existing callers of **any** workflow |

### How to cut a release

After your PR is merged to `main`:

```bash
# Create the exact version tag
git tag v1.2.3

# Move the floating major tag to the new commit
git tag -f v1

# Push both
git push origin v1.2.3
git push origin v1 --force
```

Then create a GitHub Release from the `v1.2.3` tag with a short summary of what changed.

### Floating major tags

Consumers pin to the floating tag (e.g. `@v1`), which always points to the latest `v1.x.x`. This is the same convention used by `actions/checkout`, `actions/setup-node`, etc.

If you're introducing a **major version** (`v2`), you'll create a new floating tag:

```bash
git tag v2.0.0
git tag v2
git push origin v2.0.0
git push origin v2
```

The old `v1` tag stays in place so existing callers aren't broken.

## Adding a new workflow

1. Add the workflow to `.github/workflows/workflow-<name>.yml`
2. Add a companion README at `.github/workflows/workflow-<name>.README.md` documenting inputs, outputs, prerequisites, and usage examples
3. Update the workflow table in `README.md`
4. On merge, cut a release following the steps above

## Ground rules

- **Public actions only.** This repo is (or will be) public, so workflows cannot reference anything in private repos.
- **No tokens.** Prefer OIDC and short-lived credentials over long-lived secrets.
- **Keep it simple.** Internal automation is not replicated here by design — public repo maintainers opt in to whatever release tooling they want.
