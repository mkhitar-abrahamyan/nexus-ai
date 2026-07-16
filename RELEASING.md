# Releasing

Releases are published from `.github/workflows/release.yml` with npm trusted publishing. Do not
create or store a long-lived npm token for this workflow.

## One-time npm setup

In the package settings on npmjs.com, add a GitHub Actions trusted publisher with:

- repository owner: `mkhitar-abrahamyan`;
- repository: `nexus-ai`;
- workflow filename: `release.yml`;
- environment: leave empty unless the workflow is later assigned a GitHub environment.

The workflow grants only `contents: read` and `id-token: write`, uses a compatible npm 11 client,
and publishes with provenance.

## Publish a release

1. Move the intended entries from `Unreleased` into a dated version section in `CHANGELOG.md`.
2. Set the same version in `package.json` and `package-lock.json`.
3. Run `npm ci` and `npm run check:release` from a clean checkout.
4. Commit and push the release changes.
5. Create and push a tag named exactly `v<package version>`, for example `v0.9.0`.
6. Verify the `Publish to npm` workflow and the package provenance on npmjs.com.

The workflow rejects a tag that does not match `package.json`. Never republish or move an existing
release tag; prepare a new patch release instead.
