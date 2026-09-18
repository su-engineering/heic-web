# Releasing

The initial package is `@su-engineering/heic@0.1.0`. The `/wasm` export ships in the same package. Ongoing releases use Changesets, validated GitHub Actions, and npm trusted publishing (OIDC); no npm publishing secret is required.

## One-time npm configuration

In the npm package settings for `@su-engineering/heic`, add a GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `su-engineering` |
| Repository | `heic-web` |
| Workflow filename | `release.yml` |
| Environment | Leave blank; this workflow does not use a GitHub environment. |
| Allowed actions | Enable direct `npm publish`. Stage-only permission does not support this workflow. |

The workflow file must exist on the default branch. The setting requires an interactive npm account/2FA operation. Never paste publishing credentials into an issue, pull request, or source file. Revoke the temporary initial-publish token after the launch.

See [npm's trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/). Publishing uses npm 11 on Node.js 24 and GitHub-hosted runners, with `id-token: write` scoped to the release job. The publish script explicitly invokes npm, rather than depending on a package manager's bundled publishing client.

GitHub Actions also needs permission to create pull requests. Under repository Settings → Actions → General, enable **Allow GitHub Actions to create and approve pull requests**. The workflow does not approve or auto-merge its own PRs.

## Normal release flow

1. Include a changeset with package changes: `pnpm exec changeset`. Choose patch, minor, or major and describe the observable change. Documentation/test-only changes can omit a changeset when no package release is needed.
2. Merge the contribution PR into `master` after CI passes.
3. `Release` runs the shared typecheck/build/package/unit and three-engine browser checks. If they pass, Changesets creates or updates a **Release: update package version** PR containing version/changelog changes.
4. The workflow explicitly dispatches CI on `changeset-release/master`. This is necessary because PRs created by `GITHUB_TOKEN` do not automatically trigger PR workflows. Verify the generated branch's successful checks before merging it.
5. Merge the version PR when ready. The release workflow validates that commit, publishes its new version publicly with provenance, and creates a `vX.Y.Z` tag and GitHub release.

Only the generated version PR determines a new package version; ordinary commits do not each publish. Never edit an already published version in place. Choose a new version through a changeset.

`tools/publish.mjs` queries the exact registry version and exits without publishing if it already exists. Unexpected registry errors fail closed. A newer `master` commit causes an older queued release to skip publishing so its successor can handle the release.

## Validation and package review

```sh
pnpm install --frozen-lockfile
pnpm test:all
mkdir -p /tmp/heic-pack
pnpm pack --pack-destination /tmp/heic-pack
```

Install the tarball in a clean consumer. Verify ESM/types, the `heic.global.js` browser bundle, and lazy WASM integration. Published files must include built assets and documentation without private test photos or development dependencies.

`pnpm test:package` validates declared targets and creates a bundled browser consumer for default-adapter tests. `prepublishOnly` checks type safety, build/package targets, and unit tests; the release workflow runs the browser matrix before permitting publication.

CI does not establish released-Safari or hardware HEVC coverage. Test representative consented Apple photos, tiled grids, orientations, and color behavior on target devices before claiming device support. Record skipped tests.

## Recovery

- If npm rejects OIDC authentication, confirm the trusted-publisher fields exactly match this repository and `release.yml`, direct publishing is allowed, and the workflow uses a GitHub-hosted runner with Node/npm versions meeting npm's requirements.
- If npm publishing succeeds but tagging/release creation fails, do not republish or unpublish the version. Verify the registry's `gitHead`, create the missing `vX.Y.Z` tag on that commit, and create the GitHub release from its changelog.
- If a release run is interrupted before publishing, rerun `Release` on `master`. Already published versions are skipped.
- Rotate/revoke any fallback manual publishing token and keep it outside the repository. Trusted publishing needs no persistent npm token.

For an explicitly authorized emergency manual release, authenticate interactively and run `npm publish --access public` on the validated version commit. Create its tag/release afterward. Do not use the automated release script outside GitHub Actions.
