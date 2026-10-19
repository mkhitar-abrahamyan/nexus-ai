import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkPolicyChange, type Policy, PolicyError, parsePolicy } from '../policy/index.js';
import { CliUsageError, flagBool, listFlag, type ParsedArgs, printTable, stringFlag, writeJson } from './args.js';

const run = promisify(execFile);

/**
 * `nexus policy check <policy.json> [--base <file>|git:<ref>] [--accept path,path] [--json]`.
 *
 * Validates the policy, and, given the version it replaces, lists every change: each that widens what
 * a tenant may reach, or that needs a reviewer's eye, must be acknowledged in the file's
 * `acknowledged` or with `--accept`, and content that changed must come with a new version. Exits 1
 * when the policy is not valid or a change is not acknowledged.
 */
export async function runPolicyCommand(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  if (subcommand !== 'check') throw new CliUsageError(`Unknown policy command "${subcommand ?? ''}". Use check.`);
  const [file] = args.positionals;
  if (!file)
    throw new CliUsageError(
      'nexus policy check needs a policy file: nexus policy check policy.json [--base git:main].',
    );
  const json = flagBool(args.flags, 'json');
  const base = stringFlag(args.flags, 'base');

  const after = parse(await readFile(file, 'utf8'), file, json);
  if (!after) return;
  if (base === undefined) {
    report(json, { policy: after.reference, valid: true }, `${describe(after)} is valid.`);
    return;
  }
  const text = await readBase(base, file);
  if (text === undefined) {
    report(
      json,
      { policy: after.reference, valid: true, base: null },
      `${describe(after)} is valid. ${base} has no policy at ${file}: nothing to compare.`,
    );
    return;
  }
  const before = parse(text, base, json);
  if (!before) return;

  const check = checkPolicyChange(before.document, after.document, { accept: listFlag(args.flags, 'accept') ?? [] });
  if (!check.ok) process.exitCode = 1;
  if (json) {
    writeJson({ policy: after.reference, valid: true, base: before.reference, ...check });
    return;
  }
  console.log(`${describe(after)} is valid. Compared with ${before.name}@${before.version} from ${base}:`);
  if (check.changes.length === 0) console.log('No changes.');
  else {
    const pending = new Set(check.unacknowledged);
    printTable(
      check.changes.map((change) => ({
        kind: change.kind,
        path: change.path,
        review: change.kind === 'narrowed' ? '' : pending.has(change) ? 'NOT ACKNOWLEDGED' : 'acknowledged',
        summary: change.summary,
      })),
      ['kind', 'path', 'review', 'summary'],
    );
  }
  if (check.versionUnchanged) {
    console.log('');
    console.log(`The content changed, but the version is still ${after.version}: raise it.`);
  }
  if (check.unacknowledged.length > 0) {
    const paths = check.unacknowledged.map((change) => change.path);
    console.log('');
    console.log(
      `${paths.length} change${paths.length === 1 ? '' : 's'} need${paths.length === 1 ? 's' : ''} acknowledging: add ${paths.map((item) => `"${item}"`).join(', ')} to "acknowledged" in ${file}, or pass --accept ${paths.join(',')}.`,
    );
  }
}

/** A policy read, or `undefined` with its issues reported and the exit code set. */
function parse(text: string, source: string, json: boolean): Policy | undefined {
  try {
    return parsePolicy(text);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    process.exitCode = 1;
    if (json) writeJson({ source, valid: false, issues: error.issues });
    else {
      console.log(`${source} is not a valid policy:`);
      for (const issue of error.issues) console.log(`  ${issue.path || '(document)'}: ${issue.message}`);
    }
    return undefined;
  }
}

/** The policy `--base` names: a file, or `git:<ref>` for the same file at a commit, `undefined` when it has none. */
async function readBase(base: string, file: string): Promise<string | undefined> {
  if (!base.startsWith('git:')) return readFile(base, 'utf8');
  const ref = base.slice(4);
  if (!ref) throw new CliUsageError('--base git: needs a ref, such as git:main or git:HEAD~1.');
  const git = async (args: string[]) => {
    try {
      return (await run('git', args, { cwd: path.dirname(path.resolve(file)), maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      throw new Error(stderr || (error as Error).message);
    }
  };
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch (error) {
    throw new Error(`git has no commit ${ref} where ${file} is: ${(error as Error).message || 'unknown ref'}`);
  }
  // `<ref>:./<name>` resolves against the directory git runs in. A file the commit lacks has no base.
  const object = `${ref}:./${path.basename(file)}`;
  try {
    await git(['cat-file', '-e', object]);
  } catch {
    return undefined;
  }
  return git(['show', object]);
}

function describe(policy: Policy): string {
  return `Policy ${policy.name}@${policy.version} (sha256 ${policy.hash.slice(0, 12)})`;
}

function report(json: boolean, value: unknown, text: string): void {
  if (json) writeJson(value);
  else console.log(text);
}
