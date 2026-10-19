/**
 * Policy you can review: guardrails, routing, budgets, residency, and credentials as one versioned
 * document the application supplies, validated when the client starts, compared and checked by
 * `nexus policy check` in CI, and recorded on every operation it decides.
 */
import { type SecretSource, tenantCredentials } from '../credentials/index.js';
import { type BudgetUsageStore, budgetLedger } from '../lifecycle/budget.js';
import { type RegionRule, residency } from '../residency/index.js';
import type { NexusAIConfig } from '../types/config.js';
import type { BudgetPeriod, OperationDescriptor, PolicyReference, ProviderGate } from '../types/lifecycle.js';
import type { RegionDefinition, ResidencyPolicy } from '../types/residency.js';
import type { SecurityConfig } from '../types/security.js';
import { sha256Hex } from '../utils/sha256.js';

export type { PolicyReference, ProviderGate } from '../types/lifecycle.js';

/** Which providers and models may serve: allow lists, where only what is listed may, and deny lists. */
export interface PolicyAccess {
  /** Only these providers may serve, by the name each is registered under. Absent means any. */
  allowProviders?: string[];
  /** These providers never serve. */
  denyProviders?: string[];
  /** Only these models may serve. Absent means any. */
  allowModels?: string[];
  /** These models never serve. */
  denyModels?: string[];
}

/** A policy's routing rules: for every tenant, and narrowed per tenant. */
export interface PolicyRouting extends PolicyAccess {
  /** Each tenant's own rules, applied after those for every tenant. */
  tenants?: Record<string, PolicyAccess>;
}

/** A policy's budgets, in US dollars per period. */
export interface PolicyBudgets {
  /** How long a budget lasts before it resets. Defaults to `month`. */
  period?: 'hour' | 'day' | 'week' | 'month';
  /** The budget of a tenant with none of its own, and of operations with no tenant. Absent means none. */
  default?: number;
  /** Each tenant's budget. */
  tenants?: Record<string, number>;
}

/** A policy's residency: regions, what runs in each, and each tenant's regions, as `residency()` takes them. */
export interface PolicyResidency {
  /** Every region, with its providers and twins. */
  regions: Record<string, RegionDefinition>;
  /** Each tenant's regions: `any`, `refuse`, a region, or a list, the first its home. */
  tenants?: Record<string, RegionRule>;
  /** The regions of a tenant `tenants` does not name. Defaults to `any`. */
  unassigned?: RegionRule;
  /** The regions of an operation with no tenant. Defaults to `any`. */
  untenanted?: RegionRule;
}

/** Where each tenant's provider keys are read, as `tenantCredentials()` takes it. */
export interface PolicyCredentials {
  /** The secret's name, with `{tenant}` and `{provider}` filled in. Defaults to `{tenant}/{provider}`. */
  secretName?: string;
  /** A tenant with no secret: `refuse`, the default, or `config`, the provider's configured key. */
  missing?: 'refuse' | 'config';
  /** How long a credential is reused, in milliseconds. */
  cacheMs?: number;
  /** How long a missing secret is remembered as missing, in milliseconds. */
  missingCacheMs?: number;
  /** While the secret source fails, how long a credential past its time still carries calls. */
  staleMs?: number;
}

/** A policy as its file holds it: plain JSON, every section optional but the name and the version. */
export interface PolicyDocument {
  /** The policy's name, such as `production`. */
  name: string;
  /** Its version, as you number it: raised with every change, and recorded on every operation. */
  version: string;
  /** What it is for. */
  description?: string;
  /** Guardrails: the client's `security` settings, as plain data. */
  guardrails?: SecurityConfig;
  /** Which providers and models may serve, for every tenant and per tenant. */
  routing?: PolicyRouting;
  /** What each tenant may spend. */
  budgets?: PolicyBudgets;
  /** Which regions each tenant may reach, and what runs where. */
  residency?: PolicyResidency;
  /** Where each tenant's provider keys are read. */
  credentials?: PolicyCredentials;
  /**
   * Changes this version makes that widen what a tenant may reach, or that need a reviewer's eye, by
   * the path `nexus policy check` names, such as `residency.tenants.acme`: acknowledged here, in the
   * file a reviewer reads.
   */
  acknowledged?: string[];
}

/** A validated policy, with what each operation records of it. */
export interface Policy extends PolicyReference {
  /** The document, as validated. */
  document: PolicyDocument;
  /** What each operation records. */
  reference: PolicyReference;
}

/** One thing wrong with a policy document, at its path. */
export interface PolicyIssue {
  /** Where, as a dot path such as `residency.tenants.acme`. */
  path: string;
  /** What is wrong. */
  message: string;
}

/** Raised when a policy document is not valid, with every issue found. */
export class PolicyError extends Error {
  constructor(
    /** Every issue, in document order. */
    readonly issues: PolicyIssue[],
  ) {
    super(`The policy is not valid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'PolicyError';
  }
}

const SECTIONS = new Set([
  'name',
  'version',
  'description',
  'guardrails',
  'routing',
  'budgets',
  'residency',
  'credentials',
  'acknowledged',
  '$schema',
]);
const LEVELS = ['off', 'basic', 'standard', 'strict', 'paranoid'] as const;
const PERIODS = ['hour', 'day', 'week', 'month'];
/** The level each guardrail preset runs at. */
const PRESET_LEVELS: Record<string, (typeof LEVELS)[number]> = {
  developer: 'standard',
  startup: 'strict',
  enterprise: 'strict',
  healthcare: 'paranoid',
  finance: 'paranoid',
};

/**
 * Reads and validates a policy document: its JSON text, or the document itself. Throws a
 * `PolicyError` listing every issue, so a bad policy fails as the client starts, not on a request.
 */
export function parsePolicy(input: string | unknown): Policy {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new PolicyError([{ path: '', message: `not JSON: ${(error as Error).message}` }]);
    }
  }
  const issues: PolicyIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  if (!isRecord(value)) throw new PolicyError([{ path: '', message: 'a policy is an object' }]);
  const document = value as Record<string, unknown>;

  for (const key of Object.keys(document)) if (!SECTIONS.has(key)) issue(key, 'not a policy section');
  for (const key of ['name', 'version'] as const) {
    if (typeof document[key] !== 'string' || !(document[key] as string).trim()) issue(key, 'a non-empty string');
  }
  if (document.description !== undefined && typeof document.description !== 'string') issue('description', 'a string');

  const strings = (path: string, list: unknown) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) issue(path, 'a list of strings');
  };
  const access = (path: string, rules: unknown) => {
    if (!isRecord(rules)) return issue(path, 'an object');
    for (const key of Object.keys(rules)) {
      if (
        ![
          'allowProviders',
          'denyProviders',
          'allowModels',
          'denyModels',
          ...(path === 'routing' ? ['tenants'] : []),
        ].includes(key)
      ) {
        issue(`${path}.${key}`, 'not a routing rule');
      }
    }
    for (const key of ['allowProviders', 'denyProviders', 'allowModels', 'denyModels'])
      strings(`${path}.${key}`, rules[key]);
    for (const key of ['allowProviders', 'allowModels']) {
      if (Array.isArray(rules[key]) && (rules[key] as unknown[]).length === 0) {
        issue(`${path}.${key}`, `an empty list admits nothing: leave it out to admit any, or deny "*"`);
      }
    }
  };

  const guardrails = document.guardrails;
  if (guardrails !== undefined) {
    if (!isRecord(guardrails)) issue('guardrails', 'an object');
    else {
      if (guardrails.level !== undefined && !(LEVELS as readonly unknown[]).includes(guardrails.level)) {
        issue('guardrails.level', `one of ${LEVELS.join(', ')}`);
      }
      if (guardrails.preset !== undefined && !Object.hasOwn(PRESET_LEVELS, guardrails.preset as string)) {
        issue('guardrails.preset', `one of ${Object.keys(PRESET_LEVELS).join(', ')}`);
      }
    }
  }

  const routing = document.routing;
  if (routing !== undefined) {
    access('routing', routing);
    if (isRecord(routing) && routing.tenants !== undefined) {
      if (!isRecord(routing.tenants)) issue('routing.tenants', 'an object of tenants');
      else for (const [tenant, rules] of Object.entries(routing.tenants)) access(`routing.tenants.${tenant}`, rules);
    }
  }

  const budgets = document.budgets;
  if (budgets !== undefined) {
    if (!isRecord(budgets)) issue('budgets', 'an object');
    else {
      if (budgets.period !== undefined && !PERIODS.includes(budgets.period as string))
        issue('budgets.period', `one of ${PERIODS.join(', ')}`);
      const amount = (path: string, item: unknown) => {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0)
          issue(path, 'a number of US dollars, at least 0');
      };
      if (budgets.default !== undefined) amount('budgets.default', budgets.default);
      if (budgets.tenants !== undefined) {
        if (!isRecord(budgets.tenants)) issue('budgets.tenants', 'an object of tenants');
        else for (const [tenant, item] of Object.entries(budgets.tenants)) amount(`budgets.tenants.${tenant}`, item);
      }
    }
  }

  const rules = document.residency;
  if (rules !== undefined) {
    if (!isRecord(rules) || !isRecord(rules.regions)) issue('residency.regions', 'an object of regions');
    else {
      const regions = new Set(Object.keys(rules.regions));
      const owner = new Map<string, string>();
      for (const [region, definition] of Object.entries(rules.regions)) {
        if (!isRecord(definition)) {
          issue(`residency.regions.${region}`, 'an object');
          continue;
        }
        strings(`residency.regions.${region}.providers`, definition.providers);
        const listed = [
          ...((Array.isArray(definition.providers) ? definition.providers : []) as string[]),
          ...Object.values(isRecord(definition.twins) ? definition.twins : {}).filter(
            (item): item is string => typeof item === 'string',
          ),
        ];
        if (
          definition.twins !== undefined &&
          (!isRecord(definition.twins) || !Object.values(definition.twins).every((item) => typeof item === 'string'))
        ) {
          issue(`residency.regions.${region}.twins`, 'an object of provider names');
        }
        for (const provider of listed) {
          const earlier = owner.get(provider);
          if (earlier && earlier !== region)
            issue(`residency.regions.${region}.providers`, `${provider} is also in ${earlier}`);
          owner.set(provider, region);
        }
      }
      const rule = (path: string, item: unknown) => {
        if (item === 'any' || item === 'refuse') return;
        const list = typeof item === 'string' ? [item] : item;
        if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
          return issue(path, 'any, refuse, a region, or a list of regions');
        }
        for (const region of list as string[])
          if (!regions.has(region)) issue(path, `names region "${region}", which is not defined`);
      };
      if (rules.tenants !== undefined) {
        if (!isRecord(rules.tenants)) issue('residency.tenants', 'an object of tenants');
        else for (const [tenant, item] of Object.entries(rules.tenants)) rule(`residency.tenants.${tenant}`, item);
      }
      if (rules.unassigned !== undefined) rule('residency.unassigned', rules.unassigned);
      if (rules.untenanted !== undefined) rule('residency.untenanted', rules.untenanted);
    }
  }

  const credentials = document.credentials;
  if (credentials !== undefined) {
    if (!isRecord(credentials)) issue('credentials', 'an object');
    else {
      if (credentials.secretName !== undefined && typeof credentials.secretName !== 'string')
        issue('credentials.secretName', 'a string');
      if (credentials.missing !== undefined && credentials.missing !== 'refuse' && credentials.missing !== 'config') {
        issue('credentials.missing', 'refuse or config');
      }
      for (const key of ['cacheMs', 'missingCacheMs', 'staleMs']) {
        const item = credentials[key];
        if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0))
          issue(`credentials.${key}`, 'milliseconds, at least 0');
      }
    }
  }
  strings('acknowledged', document.acknowledged);

  if (issues.length > 0) throw new PolicyError(issues);
  const valid = document as unknown as PolicyDocument;
  const reference: PolicyReference = { name: valid.name, version: valid.version, hash: policyHash(valid) };
  return { ...reference, document: valid, reference };
}

/** The SHA-256 of a policy's content, with its keys in order, so formatting never changes it. */
export function policyHash(document: PolicyDocument): string {
  return sha256Hex(canonical(document));
}

// ── Applying ──

/** What `applyPolicy()` needs that a document cannot hold. */
export interface ApplyPolicyOptions {
  /** Where tenants' provider keys are read, when the policy has a `credentials` section. */
  secrets?: SecretSource;
  /** Where budget totals are kept, shared by every replica. Defaults to memory. */
  budgetStore?: BudgetUsageStore;
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/**
 * A client's configuration under a policy: its guardrails as the `security` settings, its global
 * model rules on routing, and, in `lifecycle`, its residency, its credentials over `secrets`, its
 * budgets as a ledger, a provider gate for its per-tenant routing rules, and the policy itself, which
 * every operation then records. What the policy does not say keeps the configuration's own.
 *
 * ```ts
 * const policy = parsePolicy(await readFile('policy.json', 'utf8'));
 * const ai = new NexusAI(applyPolicy({ providers }, policy, { secrets: awsSecrets(client) }));
 * ```
 */
export function applyPolicy(config: NexusAIConfig, policy: Policy, options: ApplyPolicyOptions = {}): NexusAIConfig {
  const document = policy.document;
  const label = `policy ${policy.name}@${policy.version}`;
  const lifecycle = { ...config.lifecycle, policy: policy.reference };
  if (document.residency) lifecycle.residency = labelled(residency(document.residency), label);
  if (document.credentials) {
    if (!options.secrets)
      throw new PolicyError([{ path: 'credentials', message: 'applying it needs the secrets option' }]);
    const template = document.credentials.secretName ?? '{tenant}/{provider}';
    lifecycle.credentials = tenantCredentials({
      secrets: options.secrets,
      name: (request) =>
        request.tenantId === undefined
          ? request.provider
          : template.replaceAll('{tenant}', request.tenantId).replaceAll('{provider}', request.provider),
      ...(document.credentials.missing ? { missing: document.credentials.missing } : {}),
      ...(document.credentials.cacheMs !== undefined ? { cacheMs: document.credentials.cacheMs } : {}),
      ...(document.credentials.missingCacheMs !== undefined
        ? { missingCacheMs: document.credentials.missingCacheMs }
        : {}),
      ...(document.credentials.staleMs !== undefined ? { staleMs: document.credentials.staleMs } : {}),
    });
  }
  if (document.budgets && (document.budgets.default !== undefined || document.budgets.tenants)) {
    const budgets = document.budgets;
    lifecycle.budget = budgetLedger({
      limit: (key) => (key === 'default' ? budgets.default : (budgets.tenants?.[key] ?? budgets.default)),
      period: (budgets.period ?? 'month') as BudgetPeriod,
      ...(options.budgetStore ? { store: options.budgetStore } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
  let routing = config.routing;
  if (document.routing) {
    lifecycle.providers = providerGate(document.routing, label);
    // Routing chooses among the models the policy admits, so a request it routes is not then refused.
    const { allowModels, denyModels } = document.routing;
    if (allowModels || denyModels) {
      routing = {
        mode: 'auto',
        ...routing,
        ...(allowModels && !routing?.allowModels?.length ? { allowModels: [...allowModels] } : {}),
        ...(denyModels ? { denyModels: [...new Set([...(routing?.denyModels ?? []), ...denyModels])] } : {}),
      };
    }
  }
  return {
    ...config,
    ...(document.guardrails
      ? {
          security: {
            ...(typeof config.security === 'string' ? { level: config.security } : config.security),
            ...document.guardrails,
          },
        }
      : {}),
    ...(routing ? { routing } : {}),
    lifecycle,
  } as NexusAIConfig;
}

/**
 * A provider gate from a policy's routing rules: every tenant's first, then the operation's tenant's.
 * A name in a list matches itself, and `*` in it matches anything, as `gpt-4o*` or `*`.
 */
export function providerGate(routing: PolicyRouting, label = 'policy'): ProviderGate {
  const verdict = (
    rules: PolicyAccess | undefined,
    where: string,
    provider: string,
    model: string | undefined,
  ): true | string => {
    if (!rules) return true;
    if (matches(provider, rules.denyProviders))
      return `provider ${provider} is denied by ${where}.denyProviders (${label})`;
    if (rules.allowProviders && !matches(provider, rules.allowProviders)) {
      return `provider ${provider} is not in ${where}.allowProviders (${label})`;
    }
    if (model !== undefined) {
      if (matches(model, rules.denyModels)) return `model ${model} is denied by ${where}.denyModels (${label})`;
      if (rules.allowModels && !matches(model, rules.allowModels))
        return `model ${model} is not in ${where}.allowModels (${label})`;
    }
    return true;
  };
  return {
    check(operation: OperationDescriptor, provider: string, model?: string) {
      const every = verdict(routing, 'routing', provider, model);
      if (every !== true) return every;
      const tenant = operation.tenantId;
      if (tenant === undefined) return true;
      return verdict(routing.tenants?.[tenant], `routing.tenants.${tenant}`, provider, model);
    },
  };
}

/** A residency policy whose rules quote the policy they came from. */
function labelled(policy: ResidencyPolicy, label: string): ResidencyPolicy {
  return {
    ...policy,
    async regionsFor(tenantId) {
      const decision = await policy.regionsFor(tenantId);
      return { ...decision, rule: `${decision.rule}; ${label}` };
    },
    // `place` and `check` read the decision, so they keep working on a labelled one.
    place: (provider, decision) => policy.place(provider, decision),
    check: (target, decision) => policy.check(target, decision),
    allows: (region, decision) => policy.allows(region, decision),
    regionOf: (provider) => policy.regionOf(provider),
  };
}

// ── Comparing ──

/** How a change moves what tenants may reach. */
export type PolicyChangeKind = 'widened' | 'narrowed' | 'changed';

/** One change between two versions of a policy. */
export interface PolicyChange {
  /** Where, as a dot path such as `residency.tenants.acme`. */
  path: string;
  /** `widened` lets something reach more; `narrowed`, less; `changed`, neither, but a reviewer should see it. */
  kind: PolicyChangeKind;
  /** The value before. */
  before?: unknown;
  /** The value after. */
  after?: unknown;
  /** A sentence saying what changed. */
  summary: string;
}

/** What `checkPolicyChange()` found. */
export interface PolicyCheck {
  /** Every change, in document order. */
  changes: PolicyChange[];
  /** Changes that widen or need review and are not acknowledged. */
  unacknowledged: PolicyChange[];
  /** True when the content changed but the version did not. */
  versionUnchanged: boolean;
  /** True when nothing is unacknowledged and the version moved with the content. */
  ok: boolean;
}

/**
 * Every change between two versions of a policy, each said to widen what a tenant may reach, narrow
 * it, or change it otherwise: a region a tenant gains, a provider or twin a region gains, an allow
 * list grown or a deny list shrunk, a budget raised, guardrails lowered, or a tenant's missing key
 * falling back to the shared one all widen; a home region moved, a guardrail setting changed, or the
 * name changed need review.
 */
export function comparePolicies(before: PolicyDocument, after: PolicyDocument): PolicyChange[] {
  const changes: PolicyChange[] = [];
  const add = (path: string, kind: PolicyChangeKind, beforeValue: unknown, afterValue: unknown, summary: string) =>
    changes.push({
      path,
      kind,
      ...(beforeValue === undefined ? {} : { before: beforeValue }),
      ...(afterValue === undefined ? {} : { after: afterValue }),
      summary,
    });

  if (before.name !== after.name)
    add('name', 'changed', before.name, after.name, `renamed from ${before.name} to ${after.name}`);

  // Guardrails: a policy without them leaves the client's own, which it cannot vouch for.
  if (before.guardrails && !after.guardrails) {
    add(
      'guardrails',
      'widened',
      before.guardrails,
      undefined,
      "the policy no longer sets guardrails: the client's own apply",
    );
  } else if (before.guardrails && after.guardrails) {
    const levelOf = (guardrails: SecurityConfig) =>
      guardrails.level ?? PRESET_LEVELS[guardrails.preset ?? ''] ?? 'standard';
    const beforeLevel = LEVELS.indexOf(levelOf(before.guardrails));
    const afterLevel = LEVELS.indexOf(levelOf(after.guardrails));
    if (beforeLevel !== afterLevel) {
      const lowered = afterLevel < beforeLevel;
      add(
        'guardrails.level',
        lowered ? 'widened' : 'narrowed',
        levelOf(before.guardrails),
        levelOf(after.guardrails),
        `guardrails ${lowered ? 'lowered' : 'raised'} from ${levelOf(before.guardrails)} to ${levelOf(after.guardrails)}`,
      );
    }
    const { level: _beforeLevel, ...beforeGuards } = before.guardrails;
    const { level: _afterLevel, ...afterGuards } = after.guardrails;
    if (canonical(beforeGuards) !== canonical(afterGuards)) {
      add('guardrails', 'changed', beforeGuards, afterGuards, 'guardrail settings changed');
    }
  } else if (after.guardrails) {
    add(
      'guardrails',
      'changed',
      undefined,
      after.guardrails,
      "the policy now sets guardrails, in place of the client's own",
    );
  }

  // Routing.
  const compareAccess = (path: string, from: PolicyAccess | undefined, to: PolicyAccess | undefined) => {
    for (const [allow, deny] of [
      ['allowProviders', 'denyProviders'],
      ['allowModels', 'denyModels'],
    ] as const) {
      const was = from?.[allow];
      const now = to?.[allow];
      if (canonical(was) !== canonical(now)) {
        const grew = now === undefined || (was !== undefined && now.some((item) => !matches(item, was)));
        add(
          `${path}.${allow}`,
          grew ? 'widened' : 'narrowed',
          was,
          now,
          `${path}.${allow} ${grew ? 'admits more' : 'admits less'}: ${list(was)} to ${list(now)}`,
        );
      }
      const wasDenied = from?.[deny] ?? [];
      const nowDenied = to?.[deny] ?? [];
      if (canonical(wasDenied) !== canonical(nowDenied)) {
        const lifted = wasDenied.some((item) => !matches(item, nowDenied));
        add(
          `${path}.${deny}`,
          lifted ? 'widened' : 'narrowed',
          wasDenied,
          nowDenied,
          `${path}.${deny} ${lifted ? 'lifted' : 'added'}: ${list(wasDenied)} to ${list(nowDenied)}`,
        );
      }
    }
  };
  compareAccess('routing', before.routing, after.routing);
  for (const tenant of keysOf(before.routing?.tenants, after.routing?.tenants)) {
    compareAccess(`routing.tenants.${tenant}`, before.routing?.tenants?.[tenant], after.routing?.tenants?.[tenant]);
  }

  // Budgets: a missing budget is no limit.
  const budgetOf = (document: PolicyDocument, tenant?: string) =>
    tenant === undefined
      ? document.budgets?.default
      : (document.budgets?.tenants?.[tenant] ?? document.budgets?.default);
  const compareBudget = (path: string, was: number | undefined, now: number | undefined) => {
    if (was === now) return;
    const raised = now === undefined || (was !== undefined && now > was);
    add(
      path,
      raised ? 'widened' : 'narrowed',
      was,
      now,
      `${path} ${raised ? 'raised' : 'lowered'}: ${was ?? 'no limit'} to ${now ?? 'no limit'}`,
    );
  };
  compareBudget('budgets.default', budgetOf(before), budgetOf(after));
  for (const tenant of keysOf(before.budgets?.tenants, after.budgets?.tenants)) {
    compareBudget(`budgets.tenants.${tenant}`, budgetOf(before, tenant), budgetOf(after, tenant));
  }
  if ((before.budgets?.period ?? 'month') !== (after.budgets?.period ?? 'month')) {
    add(
      'budgets.period',
      'changed',
      before.budgets?.period ?? 'month',
      after.budgets?.period ?? 'month',
      'the budget period changed',
    );
  }

  // Residency: each rule as the regions it allows, `any` for every region there is or will be.
  const resolve = (document: PolicyDocument, rule: RegionRule | undefined): 'any' | string[] => {
    const effective = document.residency ? (rule ?? 'any') : 'any';
    if (effective === 'any') return 'any';
    if (effective === 'refuse') return [];
    return typeof effective === 'string' ? [effective] : [...effective];
  };
  const regionList = (regions: 'any' | string[]) => (regions === 'any' ? 'any region' : list(regions));
  const compareRule = (path: string, was: 'any' | string[], now: 'any' | string[]) => {
    if (was === 'any' && now === 'any') return;
    if (now === 'any')
      return add(path, 'widened', was, now, `${path} may now reach any region, not only ${regionList(was)}`);
    if (was === 'any') return add(path, 'narrowed', was, now, `${path} is held to ${regionList(now)}`);
    const gained = now.filter((region) => !was.includes(region));
    const lost = was.filter((region) => !now.includes(region));
    if (gained.length > 0) {
      add(
        path,
        'widened',
        was,
        now,
        `${path} may now reach ${gained.join(', ')}: ${regionList(was)} before, ${regionList(now)} now`,
      );
    } else if (lost.length > 0) add(path, 'narrowed', was, now, `${path} no longer reaches ${lost.join(', ')}`);
    else if (was[0] !== now[0]) add(path, 'changed', was, now, `${path} moves home from ${was[0]} to ${now[0]}`);
  };
  const unassignedOf = (document: PolicyDocument) => document.residency?.unassigned;
  for (const tenant of keysOf(before.residency?.tenants, after.residency?.tenants)) {
    compareRule(
      `residency.tenants.${tenant}`,
      resolve(before, before.residency?.tenants?.[tenant] ?? unassignedOf(before)),
      resolve(after, after.residency?.tenants?.[tenant] ?? unassignedOf(after)),
    );
  }
  compareRule('residency.unassigned', resolve(before, unassignedOf(before)), resolve(after, unassignedOf(after)));
  compareRule(
    'residency.untenanted',
    resolve(before, before.residency?.untenanted),
    resolve(after, after.residency?.untenanted),
  );
  for (const region of keysOf(before.residency?.regions, after.residency?.regions)) {
    const was = before.residency?.regions[region];
    const now = after.residency?.regions[region];
    const wasProviders = was?.providers ?? [];
    const nowProviders = now?.providers ?? [];
    const added = nowProviders.filter((provider) => !wasProviders.includes(provider));
    const removed = wasProviders.filter((provider) => !nowProviders.includes(provider));
    if (added.length > 0)
      add(
        `residency.regions.${region}.providers`,
        'widened',
        wasProviders,
        nowProviders,
        `${region} gains ${added.join(', ')}`,
      );
    else if (removed.length > 0)
      add(
        `residency.regions.${region}.providers`,
        'narrowed',
        wasProviders,
        nowProviders,
        `${region} loses ${removed.join(', ')}`,
      );
    for (const provider of keysOf(was?.twins, now?.twins)) {
      const from = was?.twins?.[provider];
      const to = now?.twins?.[provider];
      if (from === to) continue;
      const kind: PolicyChangeKind = from === undefined ? 'widened' : to === undefined ? 'narrowed' : 'changed';
      add(
        `residency.regions.${region}.twins.${provider}`,
        kind,
        from,
        to,
        `${region}'s twin of ${provider}: ${from ?? 'none'} to ${to ?? 'none'}`,
      );
    }
  }

  // Credentials.
  const missingOf = (document: PolicyDocument) =>
    document.credentials ? (document.credentials.missing ?? 'refuse') : 'config';
  if (missingOf(before) !== missingOf(after)) {
    const widened = missingOf(after) === 'config';
    add(
      'credentials.missing',
      widened ? 'widened' : 'narrowed',
      missingOf(before),
      missingOf(after),
      widened ? "a tenant with no key now gets the provider's shared one" : 'a tenant with no key is now refused',
    );
  }
  const { missing: _beforeMissing, ...beforeCredentials } = before.credentials ?? {};
  const { missing: _afterMissing, ...afterCredentials } = after.credentials ?? {};
  if (canonical(beforeCredentials) !== canonical(afterCredentials)) {
    add(
      'credentials',
      'changed',
      beforeCredentials,
      afterCredentials,
      'where or how long credentials are read changed',
    );
  }
  return changes;
}

/**
 * Checks a new version of a policy against the one before: every change, which of them widen or need
 * review without an acknowledgment, in the new document's `acknowledged` or `accept`, and whether the
 * version moved with the content. `ok` is what CI gates on.
 */
export function checkPolicyChange(
  before: PolicyDocument,
  after: PolicyDocument,
  options: { accept?: readonly string[] } = {},
): PolicyCheck {
  const changes = comparePolicies(before, after);
  const acknowledged = [...(after.acknowledged ?? []), ...(options.accept ?? [])];
  const covered = (path: string) => acknowledged.some((item) => path === item || path.startsWith(`${item}.`));
  const unacknowledged = changes.filter((change) => change.kind !== 'narrowed' && !covered(change.path));
  const { acknowledged: _beforeAcknowledged, ...beforeContent } = before;
  const { acknowledged: _afterAcknowledged, ...afterContent } = after;
  const versionUnchanged = before.version === after.version && canonical(beforeContent) !== canonical(afterContent);
  return { changes, unacknowledged, versionUnchanged, ok: unacknowledged.length === 0 && !versionUnchanged };
}

// ── Helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const patterns = new Map<string, RegExp | null>();

/**
 * Whether a name is in a list: equal to an entry, or matched by one with `*` in it. Given an entry
 * as the name, whether every name it matches is matched by the list too.
 */
function matches(value: string, entries: readonly string[] | undefined): boolean {
  return (
    entries?.some((entry) => {
      if (entry === value) return true;
      let pattern = patterns.get(entry);
      if (pattern === undefined) {
        pattern = entry.includes('*')
          ? new RegExp(
              `^${entry
                .split('*')
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('.*')}$`,
            )
          : null;
        if (patterns.size < 1024) patterns.set(entry, pattern);
      }
      return pattern?.test(value) ?? false;
    }) ?? false
  );
}

function keysOf(...objects: Array<Record<string, unknown> | undefined>): string[] {
  return [...new Set(objects.flatMap((object) => Object.keys(object ?? {})))];
}

function list(items: readonly string[] | undefined): string {
  return items === undefined ? 'any' : items.length === 0 ? 'none' : items.join(', ');
}

/** JSON with every object's keys in order. */
function canonical(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item) =>
      isRecord(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    ) ?? 'undefined'
  );
}
