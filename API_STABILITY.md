# API Stability Policy

This policy describes compatibility guarantees for `nexus-ai-pro` beginning with version 0.9.0.

## Release stages

The package is pre-1.0. Minor releases may contain breaking changes when they are necessary, but those changes will be called out in the changelog with migration guidance. Patch releases are intended to remain backward compatible.

The following surfaces are public and covered by this policy:

- exports documented in the root package or an explicit `package.json` subpath;
- exported TypeScript types and runtime symbols;
- documented configuration keys, response shapes, and CLI commands.

Source files, `dist` file paths, examples, test helpers that are not exported, and undocumented implementation details are not public API. Import only from `nexus-ai-pro` or one of its explicit subpaths.

## Compatibility rules

- A public symbol will not be removed or incompatibly changed in a patch release.
- Deprecations will be documented before removal whenever practical.
- New optional fields, providers, exports, error subclasses, and enum-like union members may be added in a minor release.
- TypeScript improvements that expose previously invalid usage may arrive in a patch release.
- Security fixes may tighten validation or blocking behavior in a patch release when preserving the old behavior would leave users exposed.
- Provider behavior can change when an upstream API changes; Nexus will preserve its normalized request and response contracts where possible.

The package is ESM-only and supports Node.js 22 or newer. CommonJS `require()` and deep imports into `dist` or `src` are not supported.

## Deprecation process

Deprecated APIs are marked with `@deprecated` in declarations and described in the changelog. During the 0.x series, removal will not normally occur earlier than the next minor release. After 1.0, removals will be reserved for major releases, except when an urgent security issue requires otherwise.

Report accidental compatibility regressions through the project issue tracker. Security issues should follow [SECURITY.md](./SECURITY.md).
