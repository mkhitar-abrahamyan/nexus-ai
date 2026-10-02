# Export Examples

This folder gives one small import example per public export area.

- `root.ts` - the root export: the client, its config builders, types, errors, and lifecycle
- `config.ts` - config builder subpath
- `providers.ts` - first-class provider classes and provider subpaths
- `runtime-modules.ts` - security, optimizer, models, evals, jobs, workflows, cache, image, voice, and telephony subpaths

Most files are import-oriented on purpose. The package exports many building blocks, and most apps should import only the pieces they use.
