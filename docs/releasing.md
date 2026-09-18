# Release checklist

Releases are maintainer-operated. The repository does not automatically publish to npm on push. Changesets is configured for public package publishing with `master` as the base branch.

## Before making the repository public

- Review the complete Git history and tracked files for credentials, private photos, sensitive metadata, and code/assets you cannot redistribute. Ignoring a file now does not remove historical copies.
- Confirm the MIT license and ownership; review optional codec license notices separately.
- Set the GitHub description, documentation homepage, and relevant topics. Keep visibility private until the owner chooses to open-source it.
- Enable issues and configure private vulnerability reporting if desired; ensure the security contact is monitored.
- Configure branch protection or a ruleset requiring the CI `check` and `browser` jobs, with appropriate maintainer access.
- Verify CI on the release commit and manually test platform HEVC and released Safari using representative, consented Apple photos, including grids.

## Prepare a version

```sh
pnpm install --frozen-lockfile
pnpm test:all
pnpm exec changeset
pnpm exec changeset version
```

Review version/changelog changes and commit them. For an initial release already at the intended version, avoid an accidental extra version bump. Inspect the package before publishing:

```sh
mkdir -p /tmp/heic-pack
pnpm pack --pack-destination /tmp/heic-pack
```

Install the tarball into a clean consumer project. Verify the ESM and declaration entry points, the `heic.global.js` browser bundle, and lazy fallback integration with the supported libheif build. The package should contain built assets, docs, README, security policy, and license, without test photographs or local dependencies.

`pnpm test:package` checks declared build targets and executes the standalone bundle in a sandbox. `prepublishOnly` checks type safety, build targets, and unit tests; it does not run the browser suite. Browser checks and device testing remain release requirements.

## Publish

Confirm npm organization access and your authenticated publishing identity. When explicitly authorized to publish:

```sh
pnpm release
```

This invokes `changeset publish`. Review the published version and registry access, then push any generated tags and create release notes summarizing behavior changes and known compatibility limits. Add provenance/trusted publishing through a separately reviewed release workflow if needed; never commit registry tokens.
