#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, readFile, stat } from 'node:fs/promises';
import { EvalRunner, type EvalCase, type EvalClient } from './evals/runner.js';
import { NexusAI } from './core/nexus.js';
import { listKnownModels, listModelsForProvider, getModelCapabilities } from './models/registry.js';
import { SecurityPipeline } from './security/index.js';
import { UploadScanner, type UploadScanFinding } from './security/upload-scanner.js';
import { TokenOptimizer } from './optimizer/index.js';
import type { CompletionRequest } from './types/messages.js';
import type { NexusAIConfig } from './types/config.js';
import type { SecurityFinding } from './types/security.js';

type Flags = Record<string, string | boolean>;

interface ParsedArgs {
  positionals: string[];
  flags: Flags;
}

interface CliFinding {
  file: string;
  type: string;
  severity: SecurityFinding['severity'];
  message: string;
  path?: string;
  value?: string;
}

const DEFAULT_SCAN_MAX_BYTES = 1_000_000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.turbo']);
const BOOLEAN_FLAGS = new Set(['all', 'densify', 'fail', 'help', 'json', 'print']);

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);

  if (!command || command === 'help' || flagBool(parsed.flags, 'help')) {
    printHelp();
    return;
  }

  switch (command) {
    case 'scan':
      await runScan(parsed);
      return;
    case 'models':
      runModels(parsed);
      return;
    case 'eval':
      await runEval(parsed);
      return;
    case 'optimize':
      await runOptimize(parsed);
      return;
    default:
      throw new Error(`Unknown command "${command}". Run "nexus help".`);
  }
}

async function runScan({ positionals, flags }: ParsedArgs): Promise<void> {
  const roots = positionals.length ? positionals : ['.'];
  const maxBytes = numberFlag(flags, 'max-bytes') ?? DEFAULT_SCAN_MAX_BYTES;
  const files = await collectFiles(roots, flagBool(flags, 'all'));
  const scanner = new UploadScanner({ maxBytes, scanTextContent: true });
  const security = new SecurityPipeline({
    level: 'standard',
    input: {
      secrets: { action: 'flag' },
      urls: { action: 'flag' },
      injectionDetection: { enabled: true, onDetection: 'flag' },
      pii: { enabled: true, action: 'flag' },
    },
  });
  const findings: CliFinding[] = [];

  for (const file of files) {
    const info = await stat(file);
    const content = info.size <= maxBytes ? await readTextIfLikely(file) : undefined;
    const uploadFindings = scanner.scan([{ name: file, sizeBytes: info.size, content }]).findings;
    findings.push(...uploadFindings.map((finding) => fromUploadFinding(file, finding)));

    if (content !== undefined) {
      const result = security.protectInput({
        model: 'nexus-scan',
        messages: [{ role: 'user', content }],
      });
      findings.push(...result.findings.filter(isUsefulCliFinding).map((finding) => fromSecurityFinding(file, finding)));
    }
  }

  const ok = !findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical');
  if (flagBool(flags, 'json')) {
    writeJson({ ok, scannedFiles: files.length, findings });
  } else {
    console.log(`Scanned ${files.length} file${files.length === 1 ? '' : 's'}.`);
    if (!findings.length) {
      console.log('No secrets, PII, or prompt-injection risks found.');
    } else {
      for (const finding of findings) {
        const value = finding.value ? ` (${truncate(finding.value, 96)})` : '';
        console.log(`${finding.severity.toUpperCase()} ${finding.type} ${finding.file}: ${finding.message}${value}`);
      }
    }
  }

  if (!ok && flags.fail !== false) process.exitCode = 1;
}

function runModels({ flags }: ParsedArgs): void {
  const provider = stringFlag(flags, 'provider');
  const models = provider ? listModelsForProvider(provider) : listKnownModels();
  const rows = models.map((name) => ({ name, capabilities: getModelCapabilities(name) }));

  if (flagBool(flags, 'json')) {
    writeJson(rows.map(({ name, capabilities }) => ({ model: name, ...capabilities })));
    return;
  }

  if (!rows.length) {
    console.log(provider ? `No known models for provider "${provider}".` : 'No known models.');
    return;
  }

  const table = rows.map(({ name, capabilities }) => ({
    model: name,
    provider: capabilities?.provider || '',
    context: String(capabilities?.maxContextTokens || ''),
    input: formatCost(capabilities?.costPer1kInput),
    output: formatCost(capabilities?.costPer1kOutput),
    status: capabilities?.status || '',
  }));
  printTable(table, ['model', 'provider', 'context', 'input', 'output', 'status']);
}

async function runOptimize({ positionals, flags }: ParsedArgs): Promise<void> {
  const request = await readRequest(positionals[0], flags);
  const maxInputTokens = numberFlag(flags, 'max-input-tokens');
  const optimizer = new TokenOptimizer({
    densification: { enabled: flagBool(flags, 'densify') },
    budget: maxInputTokens
      ? { enabled: true, maxInputTokens, onExceeded: flagBool(flags, 'densify') ? 'densify' : 'allow' }
      : undefined,
  });
  const result = optimizer.optimize(request);

  if (flagBool(flags, 'json')) {
    writeJson(result);
    return;
  }

  console.log(`Tokens: ${result.usage.beforeTokens} -> ${result.usage.afterTokens} (${result.usage.savedTokens} saved, ${result.usage.savedPercent}%).`);
  if (result.techniquesApplied.length) console.log(`Techniques: ${result.techniquesApplied.join(', ')}`);
  for (const warning of result.warnings) console.log(`WARN ${warning}`);
  if (flagBool(flags, 'print')) {
    console.log('');
    console.log(JSON.stringify(result.value, null, 2));
  }
}

async function runEval({ positionals, flags }: ParsedArgs): Promise<void> {
  const file = positionals[0];
  if (!file) throw new Error('nexus eval requires a JSON or JS eval file.');

  const loaded = await loadEvalFile(file);
  const source = unwrapDefault(loaded);
  const cases = normalizeEvalCases(readProperty(source, 'cases') || source);
  const client = readProperty(source, 'client');
  const config = readProperty(source, 'config') || configFromEnv();
  const runner = new EvalRunner(isEvalClient(client) ? client : createClient(config));
  const result = await runner.run(cases);

  if (flagBool(flags, 'json')) {
    writeJson(result);
  } else {
    console.log(`Eval ${result.passed ? 'passed' : 'failed'}: ${result.passedCount}/${result.total} passed in ${result.durationMs}ms.`);
    for (const item of result.results) {
      const detail = item.error ? ` - ${item.error}` : '';
      console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}${detail}`);
    }
  }

  if (!result.passed) process.exitCode = 1;
}

function createClient(config: unknown): NexusAI {
  if (!isRecord(config)) {
    throw new Error('Eval file must export { client } or { config, cases }. You can also set provider env vars such as OPENAI_API_KEY plus NEXUS_MODEL.');
  }
  return new NexusAI(config as unknown as NexusAIConfig);
}

function configFromEnv(): NexusAIConfig | undefined {
  const providers: NexusAIConfig['providers'] = {};

  if (process.env.OPENAI_API_KEY) providers.openai = { apiKey: process.env.OPENAI_API_KEY };
  if (process.env.ANTHROPIC_API_KEY) providers.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
  if (process.env.GOOGLE_API_KEY) providers.google = { apiKey: process.env.GOOGLE_API_KEY };
  if (process.env.GROQ_API_KEY) providers.groq = { apiKey: process.env.GROQ_API_KEY };
  if (process.env.MISTRAL_API_KEY) providers.mistral = { apiKey: process.env.MISTRAL_API_KEY };
  if (process.env.OPENROUTER_API_KEY) providers.openrouter = { apiKey: process.env.OPENROUTER_API_KEY };
  if (process.env.DEEPSEEK_API_KEY) providers.deepseek = { apiKey: process.env.DEEPSEEK_API_KEY };
  if (process.env.OLLAMA_BASE_URL) providers.ollama = { baseUrl: process.env.OLLAMA_BASE_URL };
  if (process.env.LMSTUDIO_BASE_URL) providers.lmstudio = { baseUrl: process.env.LMSTUDIO_BASE_URL };
  if (process.env.LLAMA_CPP_BASE_URL) providers.llamaCpp = { baseUrl: process.env.LLAMA_CPP_BASE_URL };

  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT) {
    providers.azureOpenAI = {
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    };
  }

  if (!Object.keys(providers).length) return undefined;

  return {
    providers,
    defaultModel: process.env.NEXUS_MODEL,
    routing: process.env.NEXUS_MODEL ? { mode: 'direct' } : undefined,
  };
}

function normalizeEvalCases(value: unknown): EvalCase<unknown>[] {
  if (!Array.isArray(value)) throw new Error('Eval file must export an array of cases or { cases: [...] }.');

  return value.map((testCase, index) => {
    if (!isRecord(testCase)) throw new Error(`Eval case at index ${index} must be an object.`);
    const normalized = { ...testCase } as unknown as EvalCase<unknown> & { contains?: string; match?: string };
    if (!normalized.name) normalized.name = `case-${index + 1}`;

    if (!normalized.assert && !normalized.judge) {
      const expected = typeof normalized.expected === 'string' ? normalized.expected : normalized.contains;
      if (typeof expected === 'string') {
        const match = normalized.match || 'includes';
        normalized.assert = (response) => matchText(responseText(response), expected, match);
      }
    }

    return normalized;
  });
}

function matchText(actual: string, expected: string, mode: string): boolean {
  if (mode === 'exact') return actual.trim() === expected.trim();
  if (mode === 'regex') return new RegExp(expected).test(actual);
  return actual.includes(expected);
}

function responseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (isRecord(response) && typeof response.content === 'string') return response.content;
  return JSON.stringify(response);
}

async function readRequest(file: string | undefined, flags: Flags): Promise<CompletionRequest> {
  const inlineText = stringFlag(flags, 'text');
  const raw = inlineText ?? (file ? await readFile(file, 'utf8') : await readStdin());
  const model = stringFlag(flags, 'model') || 'auto';

  try {
    const parsed = JSON.parse(raw);
    const request = isRecord(parsed) && isRecord(parsed.request) ? parsed.request : parsed;
    if (isCompletionRequest(request)) return request;
  } catch {
    // Plain text input is allowed.
  }

  return {
    model,
    messages: [{ role: 'user', content: raw }],
  };
}

function isCompletionRequest(value: unknown): value is CompletionRequest {
  return isRecord(value)
    && typeof value.model === 'string'
    && Array.isArray(value.messages);
}

async function loadEvalFile(file: string): Promise<unknown> {
  const fullPath = path.resolve(file);
  if (fullPath.endsWith('.json')) return JSON.parse(await readFile(fullPath, 'utf8'));
  return import(pathToFileURL(fullPath).href);
}

async function collectFiles(entries: string[], includeIgnored: boolean): Promise<string[]> {
  const files: string[] = [];
  for (const entry of entries) {
    await collectFile(path.resolve(entry), includeIgnored, files);
  }
  return files;
}

async function collectFile(entry: string, includeIgnored: boolean, files: string[]): Promise<void> {
  const info = await stat(entry);
  if (info.isFile()) {
    files.push(entry);
    return;
  }
  if (!info.isDirectory()) return;

  for (const child of await readdir(entry, { withFileTypes: true })) {
    if (!includeIgnored && child.isDirectory() && IGNORED_DIRS.has(child.name)) continue;
    await collectFile(path.join(entry, child.name), includeIgnored, files);
  }
}

async function readTextIfLikely(file: string): Promise<string | undefined> {
  const buffer = await readFile(file);
  if (buffer.includes(0)) return undefined;
  return buffer.toString('utf8');
}

function fromUploadFinding(file: string, finding: UploadScanFinding): CliFinding {
  return {
    file,
    type: 'upload',
    severity: finding.severity,
    message: finding.message,
    value: finding.value,
  };
}

function fromSecurityFinding(file: string, finding: SecurityFinding): CliFinding {
  return {
    file,
    type: finding.type,
    severity: finding.severity,
    message: finding.message,
    path: finding.path,
    value: finding.value,
  };
}

function isUsefulCliFinding(finding: SecurityFinding): boolean {
  if (finding.type !== 'pii' || finding.metadata?.piiType !== 'phone') return true;
  const digits = finding.value?.replace(/\D/g, '') || '';
  return digits.length >= 10;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    if (rawKey.startsWith('no-')) {
      flags[rawKey.slice(3)] = false;
      continue;
    }

    const next = args[index + 1];
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
    } else if (BOOLEAN_FLAGS.has(rawKey)) {
      flags[rawKey] = true;
    } else if (next && !next.startsWith('--')) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { positionals, flags };
}

function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(flags: Flags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number.`);
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function unwrapDefault(value: unknown): unknown {
  if (isRecord(value) && 'default' in value && Object.keys(value).length === 1) return value.default;
  if (isRecord(value) && isRecord(value.default) && !('cases' in value) && !('client' in value)) return value.default;
  return value;
}

function isEvalClient(value: unknown): value is EvalClient<unknown> {
  return isRecord(value) && typeof value.complete === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
  const widths = Object.fromEntries(columns.map((column) => [
    column,
    Math.max(column.length, ...rows.map((row) => row[column].length)),
  ]));
  console.log(columns.map((column) => column.padEnd(widths[column])).join('  '));
  console.log(columns.map((column) => '-'.repeat(widths[column])).join('  '));
  for (const row of rows) {
    console.log(columns.map((column) => row[column].padEnd(widths[column])).join('  '));
  }
}

function formatCost(value: number | undefined): string {
  return value === undefined ? '' : `$${value.toFixed(6)}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function printHelp(): void {
  console.log(`nexus-ai-pro CLI

Usage:
  nexus scan [paths...] [--json] [--max-bytes 1000000] [--no-fail]
  nexus models [--provider openai] [--json]
  nexus eval <eval.json|eval.mjs> [--json]
  nexus optimize [request.json|prompt.txt] [--model gpt-5-mini] [--max-input-tokens 4000] [--densify] [--json]

Eval files can export { cases, client } or { cases, config }. JSON cases may use "expected", "contains", and "match": "includes" | "exact" | "regex".`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
