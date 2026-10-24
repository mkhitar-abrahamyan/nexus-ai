/**
 * Policy you can review: one versioned document for guardrails, routing, budgets, residency, and
 * credentials.
 *
 * A provider server per region records what reaches it and with which key. The document is
 * validated as the client starts, with every issue named; applied, every operation's audit event
 * records the policy it ran under, and each refusal, by its routing rules, its regions, or its
 * budgets, names it. `nexus policy check` compares a version with the one in git before it: a change
 * that lets a tenant leave its regions fails the check until it is acknowledged, and the client
 * built from that version would indeed send the tenant's calls out of the EU.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { BudgetExceededError, callAccess, OperationDeniedError } from '../src/core/lifecycle.js';
import { NexusAI } from '../src/core/nexus.js';
import { memorySecrets } from '../src/credentials/index.js';
import { OpenAIEmbeddingProvider } from '../src/embeddings/adapters.js';
import {
  applyPolicy,
  checkPolicyChange,
  comparePolicies,
  type PolicyChange,
  type PolicyDocument,
  PolicyError,
  parsePolicy,
  providerGate,
} from '../src/policy/index.js';
import { ResidencyError } from '../src/residency/index.js';
import type { AuditLogEvent, NexusAIConfig } from '../src/types/config.js';
import type { OperationDescriptor } from '../src/types/lifecycle.js';

/** A provider server per region, recording the key of everything that reaches it. */
const regions = {
  eu: { url: '', seen: [] as string[] },
  us: { url: '', seen: [] as string[] },
};
const servers: Array<ReturnType<typeof createServer>> = [];

before(async () => {
  for (const [name, region] of Object.entries(regions)) {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        region.seen.push(String(request.headers.authorization ?? ''));
        if (request.url?.endsWith('/embeddings')) {
          // The `e-broken` model always fails, so a call to it falls back.
          const asked = JSON.parse(body) as { model: string; input: string[] };
          if (asked.model === 'e-broken') {
            response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"down"}}');
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ data: asked.input.map((_, index) => ({ embedding: [1, 0], index })), model: asked.model }),
          );
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'c',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-5',
            choices: [
              { index: 0, message: { role: 'assistant', content: `answered in ${name}` }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    region.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    servers.push(server);
  }
});
after(() => {
  for (const server of servers) server.close();
});

/** Version 3 of the production policy. */
const production = (): PolicyDocument => ({
  name: 'production',
  version: '3',
  description: 'What each tenant may reach in production.',
  guardrails: { level: 'basic' },
  routing: {
    denyModels: ['gpt-4o-mini'],
    tenants: {
      globex: { denyProviders: ['openai'], denyModels: ['e-backup'] },
      initech: { allowModels: ['gpt-5*'] },
    },
  },
  budgets: { default: 100, tenants: { hooli: 0 } },
  residency: {
    regions: {
      'eu-west': { providers: ['openai-eu', 'embed-eu'], twins: { openai: 'openai-eu' } },
      'us-east': { providers: ['openai'] },
    },
    tenants: { acme: 'eu-west', globex: 'any', initech: 'us-east', hooli: 'any' },
    unassigned: 'refuse',
  },
  credentials: { secretName: 'tenants/{tenant}/{provider}', missing: 'config' },
});

function client(document: PolicyDocument, audit: AuditLogEvent[] = []) {
  const config = {
    providers: {
      openai: { apiKey: 'sk-shared-us', baseUrl: `${regions.us.url}/v1` },
      custom: [{ name: 'openai-eu', format: 'openai', baseUrl: `${regions.eu.url}/v1`, apiKey: 'sk-shared-eu' }],
    },
    routing: { strategy: 'direct', defaultModel: 'gpt-5' },
    security: 'off',
    auditLog: { enabled: true, sink: (event: AuditLogEvent) => void audit.push(event) },
    embeddings: {
      providers: {
        'embed-eu': new OpenAIEmbeddingProvider({
          providerName: 'embed-eu',
          baseUrl: `${regions.eu.url}/v1`,
          apiKey: 'k',
          model: 'e-broken',
        }),
      },
      fallback: [{ provider: 'embed-eu', model: 'e-backup' }],
      defaultProvider: 'embed-eu',
    },
  } as unknown as NexusAIConfig;
  const secrets = memorySecrets({ 'tenants/acme/openai-eu': 'sk-acme-eu', 'tenants/acme/openai': 'sk-acme-us' });
  return new NexusAI(applyPolicy(config, parsePolicy(JSON.stringify(document)), { secrets }));
}

const messages = [{ role: 'user' as const, content: 'hello' }];
const reached = () => ({ eu: regions.eu.seen.length, us: regions.us.seen.length });

/** Runs the CLI from source, so these tests do not depend on a build. */
function nexus(args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Policy Test', '-c', 'user.email=policy@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

const hasGit = spawnSync('git', ['--version']).status === 0;

test('proof: a policy change that would let a tenant leave its regions is caught by the command line before it ships', {
  skip: !hasGit && 'git is not installed',
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-policy-'));
  try {
    const file = path.join(directory, 'policy.json');
    await writeFile(file, `${JSON.stringify(production(), null, 2)}\n`);
    git(directory, 'init', '-q');
    git(directory, 'add', 'policy.json');
    git(directory, 'commit', '-q', '-m', 'production policy, version 3');

    // Version 4 lets acme reach the US as well.
    const widened = production();
    widened.version = '4';
    (widened.residency?.tenants as Record<string, unknown>).acme = ['eu-west', 'us-east'];
    await writeFile(file, `${JSON.stringify(widened, null, 2)}\n`);

    const caught = nexus(['policy', 'check', file, '--base', 'git:HEAD']);
    assert.equal(caught.status, 1, `the check fails: ${caught.stdout}${caught.stderr}`);
    assert.match(caught.stdout, /Compared with production@3 from git:HEAD/);
    assert.match(caught.stdout, /widened\s+residency\.tenants\.acme\s+NOT ACKNOWLEDGED/);
    assert.match(caught.stdout, /residency\.tenants\.acme may now reach us-east: eu-west before, eu-west, us-east now/);
    assert.match(caught.stdout, /add "residency\.tenants\.acme" to "acknowledged"/);

    const json = nexus(['policy', 'check', file, '--base', 'git:HEAD', '--json']);
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout) as {
      ok: boolean;
      base: { version: string };
      unacknowledged: PolicyChange[];
    };
    assert.equal(report.ok, false);
    assert.equal(report.base.version, '3');
    assert.deepEqual(
      report.unacknowledged.map((change) => [change.path, change.kind]),
      [['residency.tenants.acme', 'widened']],
    );

    // The check is right: the client built from version 4 sends acme's calls to the US.
    const before = reached();
    assert.equal(
      (await client(production()).complete({ model: 'gpt-5', messages, tenantId: 'acme' })).content,
      'answered in eu',
    );
    assert.equal(
      (await client(widened).complete({ model: 'gpt-5', messages, tenantId: 'acme' })).content,
      'answered in us',
    );
    assert.deepEqual(reached(), { eu: before.eu + 1, us: before.us + 1 });

    // Accepted on the command line, or acknowledged in the file a reviewer reads, it passes.
    const accepted = nexus(['policy', 'check', file, '--base', 'git:HEAD', '--accept', 'residency.tenants.acme']);
    assert.equal(accepted.status, 0, accepted.stdout);
    await writeFile(file, `${JSON.stringify({ ...widened, acknowledged: ['residency.tenants.acme'] }, null, 2)}\n`);
    const acknowledged = nexus(['policy', 'check', file, '--base', 'git:HEAD']);
    assert.equal(acknowledged.status, 0, acknowledged.stdout);
    assert.match(acknowledged.stdout, /widened\s+residency\.tenants\.acme\s+acknowledged/);

    // The same change without a new version fails, acknowledged or not.
    await writeFile(file, `${JSON.stringify({ ...widened, version: '3', acknowledged: ['residency'] }, null, 2)}\n`);
    const unbumped = nexus(['policy', 'check', file, '--base', 'git:HEAD']);
    assert.equal(unbumped.status, 1, unbumped.stdout);
    assert.match(unbumped.stdout, /the version is still 3: raise it/);

    // A file the base commit lacks has nothing to compare; a ref git does not know is an error.
    const fresh = path.join(directory, 'staging.json');
    await writeFile(fresh, JSON.stringify({ name: 'staging', version: '1' }));
    const unborn = nexus(['policy', 'check', fresh, '--base', 'git:HEAD']);
    assert.equal(unborn.status, 0, unborn.stdout + unborn.stderr);
    assert.match(unborn.stdout, /nothing to compare/);
    const unknown = nexus(['policy', 'check', file, '--base', 'git:no-such-branch']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /git has no commit no-such-branch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the command line validates a policy alone, against a file, and refuses one that is not valid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-policy-'));
  try {
    const before = path.join(directory, 'before.json');
    const after = path.join(directory, 'after.json');
    await writeFile(before, JSON.stringify(production()));
    const valid = nexus(['policy', 'check', before]);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.match(
      valid.stdout,
      new RegExp(`Policy production@3 \\(sha256 ${parsePolicy(production()).hash.slice(0, 12)}\\) is valid`),
    );

    // Only narrowed: nothing to acknowledge.
    const narrowed = production();
    narrowed.version = '4';
    (narrowed.residency?.tenants as Record<string, unknown>).globex = 'us-east';
    await writeFile(after, JSON.stringify(narrowed));
    const passed = nexus(['policy', 'check', after, '--base', before]);
    assert.equal(passed.status, 0, passed.stdout);
    assert.match(
      passed.stdout,
      /narrowed\s+residency\.tenants\.globex\s+residency\.tenants\.globex is held to us-east/,
    );

    const unchanged = nexus(['policy', 'check', before, '--base', before]);
    assert.equal(unchanged.status, 0);
    assert.match(unchanged.stdout, /No changes\./);

    await writeFile(
      after,
      JSON.stringify({ name: 'production', version: '4', residency: { regions: {}, tenants: { acme: 'mars' } } }),
    );
    const invalid = nexus(['policy', 'check', after]);
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stdout,
      /is not a valid policy:\n {2}residency\.tenants\.acme: names region "mars", which is not defined/,
    );
    const invalidJson = nexus(['policy', 'check', after, '--json']);
    assert.equal(invalidJson.status, 1);
    assert.equal((JSON.parse(invalidJson.stdout) as { valid: boolean }).valid, false);

    const usage = nexus(['policy', 'lint', before]);
    assert.equal(usage.status, 2, 'a usage mistake exits 2');
    assert.match(usage.stderr, /Unknown policy command "lint"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a policy is validated as the client starts, with every issue named', () => {
  assert.throws(
    () =>
      parsePolicy({
        name: 'production',
        version: '',
        region: 'eu',
        guardrails: { level: 'loose', preset: 'toString' },
        routing: { allowModels: [], tenants: { acme: { allowProviders: 'openai', deny: ['x'] } } },
        budgets: { period: 'year', default: -1, tenants: { acme: 'lots' } },
        residency: {
          regions: { 'eu-west': { providers: ['openai-eu'] }, 'us-east': { providers: ['openai-eu'] } },
          tenants: { acme: ['eu-west', 'mars'], globex: 7 },
          untenanted: 'nowhere',
        },
        credentials: { missing: 'ignore', cacheMs: -5, secretName: 3 },
        acknowledged: 'residency',
      }),
    (error: unknown) => {
      assert.ok(error instanceof PolicyError, `a policy error: ${String(error)}`);
      assert.deepEqual(
        error.issues.map((issue) => issue.path),
        [
          'region',
          'version',
          'guardrails.level',
          'guardrails.preset',
          'routing.allowModels',
          'routing.tenants.acme.deny',
          'routing.tenants.acme.allowProviders',
          'budgets.period',
          'budgets.default',
          'budgets.tenants.acme',
          'residency.regions.us-east.providers',
          'residency.tenants.acme',
          'residency.tenants.globex',
          'residency.untenanted',
          'credentials.secretName',
          'credentials.missing',
          'credentials.cacheMs',
          'acknowledged',
        ],
      );
      assert.match(error.message, /residency\.regions\.us-east\.providers: openai-eu is also in eu-west/);
      assert.match(error.message, /routing\.allowModels: an empty list admits nothing/);
      return true;
    },
  );
  assert.throws(
    () => parsePolicy('{ "name": '),
    (error: unknown) => error instanceof PolicyError && /not JSON/.test(error.message),
  );
  assert.throws(() => parsePolicy([]), /a policy is an object/);

  // The hash is of the content: key order and formatting never change it, a value does.
  const policy = parsePolicy(production());
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(production()).reverse()), null, 4);
  assert.equal(parsePolicy(reordered).hash, policy.hash);
  assert.match(policy.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(parsePolicy({ ...production(), budgets: { default: 101 } }).hash, policy.hash);
  assert.deepEqual(policy.reference, { name: 'production', version: '3', hash: policy.hash });
});

test('every operation records the policy it ran under, and each refusal names it', async () => {
  const audit: AuditLogEvent[] = [];
  const ai = client(production(), audit);
  const { reference } = parsePolicy(production());
  const before = reached();

  // acme is answered in the EU, on its own key.
  assert.equal((await ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' })).content, 'answered in eu');
  assert.equal(regions.eu.seen.at(-1), 'Bearer sk-acme-eu');
  assert.ok(audit.length > 0, 'audited');
  for (const event of audit) assert.deepEqual(event.policy, reference, `${event.type} records the policy`);

  // globex may not reach openai: refused, naming the rule and the policy, and nothing is sent.
  await assert.rejects(ai.complete({ model: 'gpt-5', messages, tenantId: 'globex' }), (error: unknown) => {
    assert.ok(error instanceof OperationDeniedError, `a gate refusal: ${String(error)}`);
    assert.match(
      error.message,
      /provider openai is denied by routing\.tenants\.globex\.denyProviders \(policy production@3\)/,
    );
    return true;
  });
  // initech may use gpt-5 models only, and no tenant gpt-4o-mini.
  await assert.rejects(
    ai.complete({ model: 'gpt-4o', messages, tenantId: 'initech' }),
    /model gpt-4o is not in routing\.tenants\.initech\.allowModels \(policy production@3\)/,
  );
  await assert.rejects(
    ai.complete({ model: 'gpt-4o-mini', messages, tenantId: 'acme' }),
    /model gpt-4o-mini is denied by routing\.denyModels \(policy production@3\)/,
  );
  // A tenant the policy does not name may reach no region.
  await assert.rejects(ai.complete({ model: 'gpt-5', messages, tenantId: 'stranger' }), (error: unknown) => {
    assert.ok(error instanceof ResidencyError, `a residency refusal: ${String(error)}`);
    assert.match(error.message, /policy production@3/);
    return true;
  });
  // hooli has no budget.
  await assert.rejects(ai.complete({ model: 'gpt-5', messages, tenantId: 'hooli' }), BudgetExceededError);
  assert.deepEqual(reached(), { eu: before.eu + 1, us: before.us }, 'nothing refused was sent');
  const blocked = audit.filter((event) => event.type === 'blocked');
  assert.ok(blocked.length >= 4, `each refusal is audited: ${blocked.length}`);
  for (const event of blocked) assert.deepEqual(event.policy, reference, 'a refusal records the policy');

  // initech's gpt-5 calls go where its regions say, on the shared key: it has no secret of its own.
  assert.equal((await ai.complete({ model: 'gpt-5-mini', messages, tenantId: 'initech' })).content, 'answered in us');
  assert.equal(regions.us.seen.at(-1), 'Bearer sk-shared-us');
});

test('an embedding falls back only to a model the tenant’s policy admits', async () => {
  const ai = client(production());
  const before = reached();
  const acme = await ai.embeddings.embed({ input: ['a'], tenantId: 'acme' });
  assert.equal(acme.embeddings.length, 1, 'acme’s embedding fell back to e-backup');
  assert.equal(reached().eu, before.eu + 2, 'the broken model, then its fallback');
  // globex may not use e-backup: the fallback is no fallback for it.
  await assert.rejects(ai.embeddings.embed({ input: ['a'], tenantId: 'globex' }), /down/);
  assert.equal(reached().eu, before.eu + 3, 'only the broken model was called');
  // initech is held to the US, and may use gpt-5 models only: refused before anything is sent.
  await assert.rejects(ai.embeddings.embed({ input: ['a'], tenantId: 'initech' }), ResidencyError);
  const anywhere = client({ ...production(), residency: undefined });
  await assert.rejects(
    anywhere.embeddings.embed({ input: ['a'], tenantId: 'initech' }),
    /model e-broken is not in routing\.tenants\.initech\.allowModels \(policy production@3\)/,
  );
  assert.equal(reached().eu, before.eu + 3, 'nothing refused was sent');
});

test('a route drops each attempt the gate refuses, and a refusal says why', () => {
  const gate = providerGate({ tenants: { acme: { denyProviders: ['openai'] } } });
  const descriptor = { operation: 'complete', tenantId: 'acme' } as OperationDescriptor;
  const access = callAccess(descriptor, undefined, undefined, gate);
  assert.equal(access.place('openai'), undefined, 'refused, so placed nowhere');
  assert.deepEqual(access.place('mistral'), { provider: 'mistral' });
  assert.equal(access.allows('openai'), false);
  assert.ok(access.refusal?.('openai') instanceof OperationDeniedError, 'the gate’s refusal');
  assert.equal(access.refusal?.('mistral'), undefined);
  assert.throws(() => access.check('openai'), OperationDeniedError);
  // With no operation to judge, the gate admits.
  assert.deepEqual(callAccess(undefined, undefined, undefined, gate).place('openai'), { provider: 'openai' });
});

test('applying a policy keeps what it does not say, merges its model rules into routing, and needs secrets for credentials', () => {
  const base = {
    providers: {},
    security: 'strict',
    routing: { mode: 'auto', denyModels: ['o1'] },
    lifecycle: { residency: undefined },
  } as unknown as NexusAIConfig;
  const applied = applyPolicy(base, parsePolicy({ ...production(), credentials: undefined }));
  assert.deepEqual(applied.security, { level: 'basic' }, 'its guardrails over the client level');
  assert.deepEqual(applied.routing?.denyModels, ['o1', 'gpt-4o-mini'], 'deny lists joined');
  assert.equal(applied.lifecycle?.policy?.version, '3');
  assert.ok(
    applied.lifecycle?.residency && applied.lifecycle.providers && applied.lifecycle.budget,
    'each section applied',
  );
  assert.equal(applied.lifecycle?.credentials, undefined, 'no credentials section, none applied');

  const minimal = applyPolicy(
    { providers: {}, security: { level: 'strict' } } as NexusAIConfig,
    parsePolicy({ name: 'p', version: '1' }),
  );
  assert.deepEqual(minimal.security, { level: 'strict' }, 'no guardrails section keeps the client’s');
  assert.equal(minimal.routing, undefined);
  assert.equal(minimal.lifecycle?.budget, undefined);
  assert.equal(minimal.lifecycle?.residency, undefined);

  const level = applyPolicy(
    { providers: {}, security: 'strict' } as NexusAIConfig,
    parsePolicy({ name: 'p', version: '1', guardrails: { output: { piiRedaction: true } } }),
  );
  assert.deepEqual(level.security, { level: 'strict', output: { piiRedaction: true } }, 'the client level kept');
  const kept = applyPolicy(
    { providers: {}, routing: { mode: 'auto', allowModels: ['o1'] } } as NexusAIConfig,
    parsePolicy({ name: 'p', version: '1', routing: { allowModels: ['gpt-5*'] } }),
  );
  assert.deepEqual(kept.routing?.allowModels, ['o1'], 'the client’s own allow list kept: the gate holds the policy’s');
  const allowed = applyPolicy(
    { providers: {} } as NexusAIConfig,
    parsePolicy({ name: 'p', version: '1', routing: { allowModels: ['gpt-5*'] } }),
  );
  assert.deepEqual(allowed.routing, { mode: 'auto', allowModels: ['gpt-5*'] });

  assert.throws(
    () => applyPolicy({ providers: {} } as NexusAIConfig, parsePolicy(production())),
    (error: unknown) => error instanceof PolicyError && error.issues[0]?.path === 'credentials',
  );
});

test('the provider gate matches names and wildcards, every tenant’s rules first', () => {
  const gate = providerGate(
    {
      denyProviders: ['legacy-*'],
      tenants: {
        acme: { allowProviders: ['openai*', 'mistral'], denyModels: ['gpt-4.1'] },
        closed: { denyProviders: ['*'] },
      },
    },
    'policy p@1',
  );
  const as = (tenantId?: string) => ({ operation: 'complete', tenantId }) as OperationDescriptor;
  assert.equal(gate.check(as('acme'), 'openai-eu', 'gpt-5'), true);
  assert.equal(gate.check(as('acme'), 'mistral'), true);
  assert.equal(
    gate.check(as('acme'), 'anthropic'),
    'provider anthropic is not in routing.tenants.acme.allowProviders (policy p@1)',
  );
  assert.equal(
    gate.check(as('acme'), 'openai', 'gpt-4.1'),
    'model gpt-4.1 is denied by routing.tenants.acme.denyModels (policy p@1)',
  );
  assert.equal(gate.check(as('acme'), 'openai', 'gpt-401'), true, 'a dot matches a dot only');
  const dotted = providerGate({ denyModels: ['gpt-4.1*'] });
  assert.notEqual(dotted.check(as(), 'openai', 'gpt-4.1-mini'), true);
  assert.equal(dotted.check(as(), 'openai', 'gpt-401-mini'), true, 'a dot in a pattern matches a dot only');
  assert.equal(
    gate.check(as('closed'), 'openai'),
    'provider openai is denied by routing.tenants.closed.denyProviders (policy p@1)',
  );
  assert.equal(
    gate.check(as('other'), 'legacy-v1'),
    'provider legacy-v1 is denied by routing.denyProviders (policy p@1)',
  );
  assert.equal(gate.check(as(), 'anthropic'), true, 'an operation with no tenant follows every tenant’s rules only');
});

test('each change is said to widen, narrow, or change what a tenant may reach', () => {
  const kinds = (edit: (document: PolicyDocument) => void) => {
    const after = production();
    after.version = '4';
    edit(after);
    return comparePolicies(production(), after).map((change) => [change.path, change.kind]);
  };
  const tenants = (document: PolicyDocument) => document.residency?.tenants as Record<string, unknown>;
  const residency = (document: PolicyDocument) => document.residency as NonNullable<PolicyDocument['residency']>;
  const routing = (document: PolicyDocument) => document.routing as NonNullable<PolicyDocument['routing']>;

  assert.deepEqual(
    kinds(() => {}),
    [],
  );
  // Regions.
  assert.deepEqual(
    kinds((d) => (tenants(d).acme = 'any')),
    [['residency.tenants.acme', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (tenants(d).globex = ['eu-west'])),
    [['residency.tenants.globex', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (tenants(d).acme = 'refuse')),
    [['residency.tenants.acme', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (tenants(d).initech = ['eu-west', 'us-east'])),
    [['residency.tenants.initech', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => delete tenants(d).acme),
    [['residency.tenants.acme', 'narrowed']],
    'unassigned refuses',
  );
  assert.deepEqual(
    kinds((d) => (residency(d).unassigned = 'eu-west')),
    [['residency.unassigned', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (residency(d).untenanted = 'us-east')),
    [['residency.untenanted', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => delete d.residency),
    [
      ['residency.tenants.acme', 'widened'],
      ['residency.tenants.initech', 'widened'],
      ['residency.unassigned', 'widened'],
      ['residency.regions.eu-west.providers', 'narrowed'],
      ['residency.regions.eu-west.twins.openai', 'narrowed'],
      ['residency.regions.us-east.providers', 'narrowed'],
    ],
  );
  const moved = production();
  (moved.residency?.tenants as Record<string, unknown>).acme = ['eu-west', 'us-east'];
  const home = production();
  home.version = '4';
  (home.residency?.tenants as Record<string, unknown>).acme = ['us-east', 'eu-west'];
  assert.deepEqual(
    comparePolicies(moved, home).map((change) => [change.path, change.kind, change.summary]),
    [['residency.tenants.acme', 'changed', 'residency.tenants.acme moves home from eu-west to us-east']],
  );
  // What runs where.
  assert.deepEqual(
    kinds((d) => (residency(d).regions['us-east'] = { providers: ['openai', 'anthropic'] })),
    [['residency.regions.us-east.providers', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (residency(d).regions['us-east'] = {})),
    [['residency.regions.us-east.providers', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (residency(d).regions['ap-south'] = { providers: ['openai-ap'] })),
    [['residency.regions.ap-south.providers', 'widened']],
    'a new region widens only what it runs: a tenant held to its regions does not gain it',
  );
  assert.deepEqual(
    kinds(
      (d) =>
        (residency(d).regions['eu-west'] = {
          providers: ['openai-eu', 'embed-eu'],
          twins: { openai: 'openai-eu', anthropic: 'openai-eu' },
        }),
    ),
    [['residency.regions.eu-west.twins.anthropic', 'widened']],
  );
  assert.deepEqual(
    kinds(
      (d) =>
        (residency(d).regions['eu-west'] = {
          providers: ['openai-eu', 'embed-eu', 'openai-eu2'],
          twins: { openai: 'openai-eu2' },
        }),
    ),
    [
      ['residency.regions.eu-west.providers', 'widened'],
      ['residency.regions.eu-west.twins.openai', 'changed'],
    ],
  );
  // Routing.
  assert.deepEqual(
    kinds((d) => (routing(d).denyModels = [])),
    [['routing.denyModels', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (routing(d).denyModels = ['gpt-4o-mini', 'o1'])),
    [['routing.denyModels', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (routing(d).allowProviders = ['openai'])),
    [['routing.allowProviders', 'narrowed']],
  );
  const tenantRules = (d: PolicyDocument) => routing(d).tenants as Record<string, Record<string, string[]>>;
  assert.deepEqual(
    kinds((d) => (tenantRules(d).initech = { allowModels: ['gpt-5*', 'o3'] })),
    [['routing.tenants.initech.allowModels', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (tenantRules(d).initech = { allowModels: ['gpt-5-mini'] })),
    [['routing.tenants.initech.allowModels', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (tenantRules(d).initech = {})),
    [['routing.tenants.initech.allowModels', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (tenantRules(d).globex = { ...tenantRules(d).globex, denyProviders: ['openai', 'mistral'] })),
    [['routing.tenants.globex.denyProviders', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => delete tenantRules(d).globex),
    [
      ['routing.tenants.globex.denyProviders', 'widened'],
      ['routing.tenants.globex.denyModels', 'widened'],
    ],
  );
  assert.deepEqual(
    kinds((d) => (routing(d).denyModels = ['gpt-4*'])),
    [['routing.denyModels', 'narrowed']],
    'a pattern that covers what it replaces lifts nothing',
  );
  assert.deepEqual(
    kinds((d) => (routing(d).denyModels = ['gpt-4o'])),
    [['routing.denyModels', 'widened']],
  );
  // Budgets.
  assert.deepEqual(
    kinds((d) => (d.budgets = { default: 100, tenants: { hooli: 5 } })),
    [['budgets.tenants.hooli', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (d.budgets = { default: 50, tenants: { hooli: 0 } })),
    [['budgets.default', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (d.budgets = { tenants: { hooli: 0 } })),
    [['budgets.default', 'widened']],
    'no default is no limit',
  );
  assert.deepEqual(
    kinds((d) => (d.budgets = { default: 100 })),
    [['budgets.tenants.hooli', 'widened']],
    'hooli falls to the default',
  );
  assert.deepEqual(
    kinds((d) => (d.budgets = { ...d.budgets, period: 'day' })),
    [['budgets.period', 'changed']],
  );
  // Guardrails.
  assert.deepEqual(
    kinds((d) => (d.guardrails = { level: 'off' })),
    [['guardrails.level', 'widened']],
  );
  assert.deepEqual(
    kinds((d) => (d.guardrails = { level: 'paranoid' })),
    [['guardrails.level', 'narrowed']],
  );
  assert.deepEqual(
    kinds((d) => (d.guardrails = { preset: 'healthcare' })),
    [
      ['guardrails.level', 'narrowed'],
      ['guardrails', 'changed'],
    ],
  );
  assert.deepEqual(
    kinds((d) => (d.guardrails = { level: 'basic', output: { piiRedaction: false } })),
    [['guardrails', 'changed']],
  );
  assert.deepEqual(
    comparePolicies(
      { name: 'p', version: '1', guardrails: { preset: 'finance' } },
      { name: 'p', version: '2', guardrails: { preset: 'developer' } },
    ).map((change) => [change.path, change.kind]),
    [
      ['guardrails.level', 'widened'],
      ['guardrails', 'changed'],
    ],
    'a preset runs at its own level',
  );
  assert.deepEqual(
    kinds((d) => delete d.guardrails),
    [['guardrails', 'widened']],
  );
  assert.deepEqual(
    comparePolicies({ name: 'p', version: '1' }, { name: 'p', version: '2', guardrails: { level: 'off' } }).map(
      (c) => c.kind,
    ),
    ['changed'],
  );
  // Credentials and the name.
  assert.deepEqual(
    kinds((d) => (d.credentials = { ...d.credentials, missing: 'refuse' })),
    [['credentials.missing', 'narrowed']],
  );
  const refusing = { ...production(), credentials: { secretName: 'tenants/{tenant}/{provider}' } };
  assert.deepEqual(
    comparePolicies(refusing, {
      ...refusing,
      version: '4',
      credentials: { ...refusing.credentials, missing: 'config' },
    }).map((c) => [c.path, c.kind]),
    [['credentials.missing', 'widened']],
  );
  assert.deepEqual(
    comparePolicies(refusing, { ...refusing, version: '4', credentials: undefined }).map((c) => [c.path, c.kind]),
    [
      ['credentials.missing', 'widened'],
      ['credentials', 'changed'],
    ],
  );
  assert.deepEqual(
    kinds((d) => (d.credentials = { ...d.credentials, cacheMs: 1000 })),
    [['credentials', 'changed']],
  );
  assert.deepEqual(
    kinds((d) => (d.name = 'prod')),
    [['name', 'changed']],
  );
});

test('a check needs every widening change acknowledged, by its path or a section above it, and a new version', () => {
  const after = production();
  after.version = '4';
  (after.residency?.tenants as Record<string, unknown>).acme = ['eu-west', 'us-east'];
  after.budgets = { default: 200, tenants: { hooli: 0 } };
  after.guardrails = { level: 'paranoid' };

  const plain = checkPolicyChange(production(), after);
  assert.equal(plain.ok, false);
  assert.deepEqual(
    plain.unacknowledged.map((change) => change.path),
    ['budgets.default', 'residency.tenants.acme'],
    'the raised guardrails need nothing',
  );
  assert.equal(plain.changes.length, 3);
  assert.equal(checkPolicyChange(production(), after, { accept: ['budgets', 'residency.tenants.acme'] }).ok, true);
  assert.equal(
    checkPolicyChange(production(), { ...after, acknowledged: ['budgets.default', 'residency.tenants'] }).ok,
    true,
    'a section above a path acknowledges it',
  );
  assert.deepEqual(
    checkPolicyChange(production(), {
      ...after,
      acknowledged: ['budgets.default', 'residency.tenants.ac'],
    }).unacknowledged.map((change) => change.path),
    ['residency.tenants.acme'],
    'a prefix of a name is not its section',
  );

  // The version moves with the content; acknowledgments alone are not content.
  assert.equal(checkPolicyChange(production(), { ...production(), budgets: { default: 50 } }).versionUnchanged, true);
  const noted = checkPolicyChange(production(), { ...production(), acknowledged: ['budgets'] });
  assert.equal(noted.versionUnchanged, false);
  assert.equal(noted.ok, true);

  // A change that neither widens nor narrows still needs a reviewer: a tenant's home moving.
  const spread = production();
  (spread.residency?.tenants as Record<string, unknown>).acme = ['eu-west', 'us-east'];
  const moved = {
    ...spread,
    version: '4',
    residency: { ...spread.residency, tenants: { ...spread.residency?.tenants } },
  };
  (moved.residency.tenants as Record<string, unknown>).acme = ['us-east', 'eu-west'];
  assert.deepEqual(
    checkPolicyChange(spread, moved as PolicyDocument).unacknowledged.map((change) => [change.path, change.kind]),
    [['residency.tenants.acme', 'changed']],
  );
});
