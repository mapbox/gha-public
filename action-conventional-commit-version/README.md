# Conventional Commit Version

Computes the next npm version to publish from [Conventional Commits](https://www.conventionalcommits.org/), using the package registry -- not git tags -- as the source of truth for the current version. No third-party dependencies: Conventional Commits parsing is self-contained. Inspired by "semantic-release", but nothing is ever committed back to the repo.

On a push to the default branch, the version is bumped based on the commits since the last release (the commit the published version was built from, which npm records as `gitHead`; else `before-sha`):

| Commit type | Bump |
|---|---|
| `feat` | minor |
| `fix`, `perf`, `revert` | patch |
| any type with a `!` after it (e.g. `feat!:`), or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer anywhere in the commit message | major, regardless of type |
| anything else (`chore`, `docs`, `style`, `refactor`, `test`, `build`, `ci`, or a non-Conventional-Commits message) | no release |

If none of the commits in range warrant a release, `skip` is `"true"` and `version` is empty.

On any other branch, or a `workflow_dispatch` run, the version is the next patch with a `-<shortsha>` prerelease suffix instead (e.g. `1.15.1-abc1234` when `1.15.0` is published), published under the `prerelease` dist-tag.

The action runs `npm view <package> version gitHead --json` against whichever registry npm is configured for. Public packages on npmjs.com need no credentials; for a private registry, configure npm credentials in an earlier step.

Squash merging with the PR title as the commit message works best, so each PR title decides its bump.

## Usage

Publishing to npmjs.com with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no npm token). Configure the package's trusted publisher with this workflow's filename and the `npm-release` environment.

```yaml
# .github/workflows/npm-release.yml
on:
  push:
    branches: ["main"]
  workflow_dispatch: {}

permissions:
  id-token: write
  contents: read

concurrency:
  group: npm-release-${{ github.ref_name }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    environment: npm-release
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # full history, to diff against before-sha or the last release's commit
          persist-credentials: false

      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc

      - name: Upgrade npm for OIDC trusted publishing support
        run: npm install -g npm@^11.5.1

      - run: npm ci
      - run: npm test

      - id: version
        uses: mapbox/gha-public/action-conventional-commit-version@main
        with:
          before-sha: ${{ github.event.before }}
          after-sha: ${{ github.event.after }}

      - if: steps.version.outputs.skip != 'true'
        run: |
          npm version ${{ steps.version.outputs.version }} --no-git-tag-version
          npm publish --access public --tag ${{ steps.version.outputs.npm_publish_tag }}
```

The concurrency group runs releases one at a time, so two runs can't publish the same version or move `latest` backwards. A queued run that gets superseded is dropped; since the range starts at the last release, its commits roll into the next one.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `before-sha` | No | | The commit sha before the push, e.g. `${{ github.event.before }}` |
| `after-sha` | No | | The commit sha after the push, e.g. `${{ github.event.after }}` |
| `working-directory` | No | `.` | Directory containing the `package.json` to read and version |
| `default-branch` | No | `main` | The branch that gets real releases; any other branch always gets a prerelease |

## Outputs

| Name | Description |
|------|-------------|
| `version` | The version to publish. Empty if `skip` is `"true"` |
| `skip` | `"true"` if no commits in range warrant a release; publishing should be skipped |
| `npm_publish_tag` | The npm dist-tag to publish under: `"latest"` for a real release, `"prerelease"` otherwise |

## Why the registry, not git tags?

This action never creates or reads git tags, and therefore needs no `contents: write` permission. Even where the last release's commits end comes from the registry: npm records the commit each version was published from as `gitHead`.

`package.json`'s own `version` field may still be ahead of the registry (e.g. bumped manually to skip a version) -- the action takes the higher of the two -- but it's never required to be in sync, and this action never commits a version bump back to the repo.

## Migrating an existing project to use this action

1. Add the workflow above, adjusting the build and test steps to your project.
2. Ensure `package.json`'s version is valid semver and greater than or equal to the latest published version.
3. Configure the package's trusted publisher on npmjs.com (workflow `npm-release.yml`, environment `npm-release`). The first publish must happen within 2 days of configuring it.
