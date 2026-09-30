import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import { functionAssistant } from '../src/server/assistant.js';
import { createAgentServer } from '../src/server/server.js';

const DEPLOY = join(import.meta.dirname, '..', 'deploy');

type Manifest = {
  kind: string;
  metadata: { name: string };
  spec?: Record<string, unknown>;
};

function manifests(): Manifest[] {
  const dir = join(DEPLOY, 'kubernetes');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml') && file !== 'kustomization.yaml')
    .flatMap((file) =>
      parseAllDocuments(readFileSync(join(dir, file), 'utf8')).map((document) => {
        assert.deepEqual(document.errors, [], `${file} parses`);
        return document.toJS() as Manifest;
      }),
    );
}

function containerEnv(manifest: Manifest): Record<string, string | undefined> {
  const template = (
    manifest.spec as { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } }
  ).template;
  return Object.fromEntries(template.spec.containers[0]?.env.map((item) => [item.name, item.value]) ?? []);
}

test('every setting the manifests and the chart pass is one the template server reads', () => {
  const server = readFileSync(join(DEPLOY, 'app', 'server.mjs'), 'utf8');
  const read = new Set([...server.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]));
  const passed = new Set<string>();
  for (const manifest of manifests().filter((item) => item.kind === 'Deployment')) {
    for (const name of Object.keys(containerEnv(manifest))) passed.add(name);
  }
  for (const file of readdirSync(join(DEPLOY, 'helm', 'agent-server', 'templates'))) {
    const text = readFileSync(join(DEPLOY, 'helm', 'agent-server', 'templates', file), 'utf8');
    for (const match of text.matchAll(/- name: ([A-Z_]+)/g)) passed.add(match[1] as string);
  }
  const compose = parseYaml(readFileSync(join(DEPLOY, 'compose.yaml'), 'utf8')) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  for (const service of Object.values(compose.services))
    for (const name of Object.keys(service.environment ?? {})) passed.add(name);

  assert.ok(passed.size > 8);
  for (const name of passed) assert.ok(read.has(name), `server.mjs reads ${name}`);
});

test('the autoscalers read metrics the server reports, sized by the workers’ concurrency', async () => {
  const all = manifests();
  const worker = all.find(
    (item) => item.kind === 'Deployment' && item.metadata.name === 'agent-server-worker',
  ) as Manifest;
  const concurrency = containerEnv(worker).CONCURRENCY;
  const keda = all.find((item) => item.kind === 'ScaledObject') as Manifest;
  const trigger = (
    keda.spec as { triggers: Array<{ metadata: { url: string; valueLocation: string; targetValue: string } }> }
  ).triggers[0]?.metadata;
  const hpa = all.find((item) => item.kind === 'HorizontalPodAutoscaler') as Manifest;
  const external = (
    hpa.spec as { metrics: Array<{ external: { metric: { name: string }; target: { averageValue: string } } }> }
  ).metrics[0]?.external;
  assert.equal(trigger?.targetValue, concurrency, 'KEDA sizes the pool by each worker’s concurrency');
  assert.equal(external?.target.averageValue, concurrency, 'so does the HPA');

  const server = createAgentServer({ assistants: { a: functionAssistant(() => 1) }, queue: { concurrency: 4 } });
  const url = new URL(trigger?.url ?? '');
  const scaling = (await (await server.handle(new Request(`http://api${url.pathname}`))).json()) as Record<
    string,
    unknown
  >;
  assert.equal(typeof scaling[trigger?.valueLocation ?? ''], 'number', `/scaling reports ${trigger?.valueLocation}`);
  const metrics = await (await server.handle(new Request('http://api/metrics'))).text();
  assert.match(metrics, new RegExp(`^${external?.metric.name} `, 'm'), `/metrics reports ${external?.metric.name}`);

  for (const deployment of all.filter(
    (item) => item.kind === 'Deployment' && item.metadata.name.startsWith('agent-server-'),
  )) {
    const container = (
      deployment.spec as {
        template: { spec: { containers: Array<{ readinessProbe: { httpGet: { path: string } } }> } };
      }
    ).template.spec.containers[0];
    assert.equal(container?.readinessProbe.httpGet.path, '/health');
  }
  assert.equal((await server.handle(new Request('http://api/health'))).status, 200);
});

test('the chart lints and renders, when helm is installed', (context) => {
  const helm = process.env.HELM ?? 'helm';
  try {
    execFileSync(helm, ['version', '--short'], { stdio: 'ignore' });
  } catch {
    context.skip('helm is not installed');
    return;
  }
  const chart = join(DEPLOY, 'helm', 'agent-server');
  execFileSync(helm, ['lint', chart], { stdio: 'pipe' });
  for (const mode of ['keda', 'hpa', 'none']) {
    const rendered = execFileSync(helm, ['template', 'demo', chart, '--set', `autoscaling.mode=${mode}`], {
      encoding: 'utf8',
    });
    const kinds = parseAllDocuments(rendered).map((document) => (document.toJS() as Manifest | null)?.kind);
    assert.ok(kinds.includes('Deployment'), mode);
    assert.equal(kinds.includes('ScaledObject'), mode === 'keda', mode);
    assert.equal(kinds.includes('HorizontalPodAutoscaler'), mode === 'hpa', mode);
  }
});
