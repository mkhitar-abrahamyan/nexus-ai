# Contributing

Thanks for improving `nexus-ai-pro`.

## Development setup

Use Node.js 22 or 24 and the npm version declared in `package.json`.

```bash
npm ci
npm run check
```

Before opening a release-related change, also run:

```bash
npm run check:release
```

The tagged trusted-publishing procedure and one-time npm configuration are documented in
[RELEASING.md](./RELEASING.md).

Real-provider conformance tests are optional and require your own credentials:

```bash
npm run test:conformance:real
```

Never commit provider keys, user data, generated tarballs, or local environment files.

## Changes

- Keep changes focused and add a regression test for behavior fixes.
- Add root exports only for broadly useful APIs; prefer a focused explicit subpath for optional integrations.
- Update the package smoke, API contract, and external type-consumer checks when the public surface changes.
- Document user-visible changes under `Unreleased` in `CHANGELOG.md`.
- Follow `API_STABILITY.md` when changing public types or behavior.

By contributing, you agree that your contribution is licensed under the MIT license used by this project.
