# Releasing

Releases are published from `.github/workflows/release.yml` with npm trusted publishing. Do not
create or store a long-lived npm token for this workflow.

The repository publishes two packages from one tag: `nexus-ai-pro` from the root, and
`nexus-ai-pro-studio` from `studio/`. They share a version number.

## One-time npm setup

In the settings of each package on npmjs.com — `nexus-ai-pro` and `nexus-ai-pro-studio` — add a
GitHub Actions trusted publisher with:

- repository owner: `mkhitar-abrahamyan`;
- repository: `nexus-ai`;
- workflow filename: `release.yml`;
- environment: leave empty unless the workflow is later assigned a GitHub environment.

The workflow grants only `contents: read` and `id-token: write`, uses a compatible npm 11 client,
and publishes with provenance.

## Publish a release

1. Move the intended entries from `Unreleased` into a dated version section in `CHANGELOG.md`.
2. Set the same version in `package.json`, in `package-lock.json` (the root entry and its package
   entry), and in `studio/package.json`. When the studio uses a core feature the release adds, raise
   the `nexus-ai-pro` floor in `studio/package.json`'s `peerDependencies` to this version.
3. Run `npm ci` and `npm run check:release` from a clean checkout.
4. Commit and push the release changes.
5. Create and push a tag named exactly `v<package version>`, for example `v0.9.0`.
6. Verify the `Publish to npm` workflow and both packages' provenance on npmjs.com.

The workflow rejects a tag that does not match `package.json`. Never republish or move an existing
release tag; prepare a new patch release instead.

## The studio

After the core package, the workflow publishes the studio when its version is not on npm yet, and
skips it when that version is already there. Its `prepublishOnly` script builds it, so nothing else
needs to run first.

Trusted publishing can only be configured for a package that exists, so the studio's first version
is published by hand, once:

1. Release the core package first, so the studio's peer dependency can be installed.
2. From `studio/`, logged in to npm as the account that will own the package, run `npm publish`.
3. Add the trusted publisher to `nexus-ai-pro-studio` on npmjs.com, as above.
4. Check it with `npm view nexus-ai-pro-studio version`.

Until then, each release's workflow ends with a warning that the studio is not on npm, and the
studio is not published.

Between releases, the studio's peer floor can name the version being prepared, which the core's
version field does not reach until the release. `npm run test:studio-install` allows exactly that
case — the floor is the next patch, minor, or major — and installs without the peer check; any other
mismatch fails, and once the release bumps the version the check is strict again.
