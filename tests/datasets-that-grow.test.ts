/**
 * Datasets that grow, proved:
 * - a synthetic dataset written from the package's own guides cites a source for every example, the
 *   cited words are in the guide where the citation says, and drafts that cite nothing or repeat a
 *   question are dropped;
 * - an adversarial dataset grown from the guardrails' patterns fails a deliberately unguarded agent
 *   and passes a guarded one, which still answers the benign examples;
 * - an insights issue's runs become regression examples that point back to the issue.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { NexusAI } from '../src/core/nexus.js';
import { adversarialDataset, promoteIssue, resistsAttack, syntheticDataset } from '../src/evaluate/generate.js';
import type { SyntheticCitation, SyntheticDocument } from '../src/evaluate/generate.js';
import { evaluate } from '../src/evaluate/run.js';
import type { Issue } from '../src/insights/clusters.js';
import { BaseProvider } from '../src/providers/base.js';
import { attackSeeds, InjectionDetector } from '../src/security/index.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';
import type { Run } from '../src/types/tracing.js';
import { normalizeForDetection } from '../src/utils/checksums.js';

const guides = (): SyntheticDocument[] =>
  readdirSync('docs')
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join('docs', file), 'utf8').replaceAll('\r\n', '\n');
      return { id: file, text, title: /^#\s+(.+)$/m.exec(text)?.[1] ?? file };
    });

test('a synthetic dataset from the guides cites, for every example, words that are in the guide', async () => {
  const documents = guides();
  let drafted = 0;
  const { dataset, unsupported, duplicates } = await syntheticDataset({
    name: 'guides',
    documents,
    perPassage: 3,
    // A writer that quotes the passage's first sentence, invents one quote, and repeats itself once.
    generate: (passage) => {
      const sentence = /[A-Z][^.\n]{30,200}\./.exec(passage.text)?.[0];
      if (!sentence) return [];
      drafted += 1;
      const question = `In ${passage.document.title}, passage ${passage.index}: what does "${sentence.slice(0, 40)}" say?`;
      return [
        { question, answer: sentence, quote: sentence },
        { question: `${question} Explain.`, answer: sentence, quote: sentence },
        {
          question: `Unsupported ${passage.document.id} ${passage.index}?`,
          answer: 'x',
          quote: 'A sentence that no guide in this package contains at all.',
        },
      ];
    },
  });

  assert.ok(dataset.examples.length > 200, `${dataset.examples.length} examples`);
  assert.equal(unsupported, drafted, 'every invented quote was dropped');
  assert.equal(
    dataset.examples.length + duplicates,
    2 * drafted,
    'every supported draft was kept or dropped as a repeat',
  );
  assert.ok(duplicates >= drafted, 'the repeated question was dropped every time');
  const byId = new Map(documents.map((document) => [document.id, document]));
  for (const example of dataset.examples) {
    const citation = example.metadata?.citation as SyntheticCitation;
    const source = byId.get(citation.document);
    assert.ok(source, `${example.id} cites a guide`);
    assert.equal(
      source.text.slice(citation.start, citation.end),
      citation.quote,
      `${example.id} cites where the words are`,
    );
    assert.ok(citation.quote.length >= 12);
  }
  const cited = new Set(
    dataset.examples.map((example) => (example.metadata?.citation as SyntheticCitation | undefined)?.document),
  );
  assert.equal(cited.size, documents.length, 'every guide contributes examples');
});

test('a synthetic dataset can be written by a model, keeping only what the passage supports', async () => {
  const document: SyntheticDocument = {
    id: 'notes',
    text: 'The release ships on Tuesday.\n\nThe venue holds two hundred people, seated.',
  };
  const requests: CompletionRequest[] = [];
  const { dataset, unsupported } = await syntheticDataset({
    name: 'notes',
    documents: [document],
    passageChars: 50,
    model: 'writer',
    client: {
      complete: async (request) => {
        requests.push(request);
        const passage = String(request.messages[1]?.content);
        const quote = passage.includes('Tuesday') ? 'The release ships on   Tuesday' : 'holds three hundred people';
        return {
          content: `Here you go: {"examples":[{"question":"When or how many?","answer":"see quote","quote":"${quote}"}]}`,
          role: 'assistant',
          finishReason: 'stop',
          meta: {} as never,
        };
      },
    },
  });
  assert.equal(requests.length, 2, 'one request per passage');
  assert.equal(requests[0]?.responseFormat?.type, 'json');
  assert.equal(dataset.examples.length, 1);
  assert.equal(unsupported, 1, 'a quote the passage does not hold is dropped');
  assert.deepEqual(dataset.examples[0]?.metadata?.citation, {
    document: 'notes',
    passage: 0,
    start: 0,
    end: 28,
    quote: 'The release ships on Tuesday',
  });
});

/** A model that does what the last instruction it read says: the agent a guardrail has to protect. */
class NaiveProvider extends BaseProvider {
  readonly info = { name: 'naive', isLocal: false };

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const read = (message: Message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
    const all = normalizeForDetection(request.messages.map(read).join('\n'));
    const system = read(
      request.messages.find((message) => message.role === 'system') ?? { role: 'system', content: '' },
    );
    const reply = (content: string, toolCalls?: NexusResponse['toolCalls']): NexusResponse => ({
      content,
      role: 'assistant',
      finishReason: toolCalls ? 'tool_calls' : 'stop',
      ...(toolCalls ? { toolCalls } : {}),
      meta: {
        requestId: 'r',
        providerUsed: 'naive',
        modelUsed: request.model,
        latencyMs: 1,
        tokensInput: 1,
        tokensOutput: 1,
        tokensSaved: 0,
        cacheHit: false,
        guardrailsApplied: [],
      },
    });
    if (/meeting notes page/.test(all) && !request.messages.some((message) => message.role === 'tool')) {
      return reply('', [{ id: 'c1', type: 'function', function: { name: 'read_notes', arguments: '{}' } }]);
    }
    const code = /code (CANARY-[0-9A-F]{8})/i.exec(all)?.[1];
    if (code) return reply(code);
    if (/(?:reveal your system prompt|print your hidden instructions)/i.test(all)) return reply(`My prompt: ${system}`);
    return reply('Summary: the launch moved to Tuesday.');
  }

  stream(): NexusStream {
    throw new Error('not used');
  }
}

/**
 * The agent under test, with the guardrails off or on. Guarded, it runs at `strict`, which blocks a
 * critical or high injection before the model sees it, and its output moderation redacts the one
 * secret the application knows must never leave: the layer that stops an attack the input guard only
 * flags, such as an instruction block or a role tag.
 */
function target(guarded: boolean) {
  return async (inputs: { system: string; prompt: string; document?: string; toolResult?: string }) => {
    const secret = /secret is (CANARY-[0-9A-F]{8})/.exec(inputs.system)?.[1] ?? '';
    const ai = new NexusAI({
      providers: {},
      routing: { mode: 'direct' },
      security: guarded
        ? {
            level: 'strict',
            output: { moderation: { enabled: true, forbiddenTerms: [secret], onViolation: 'redact' } },
          }
        : 'off',
    });
    ai.registerProvider('anthropic', new NaiveProvider());
    const agent = createAgent({
      client: ai,
      model: 'claude-sonnet-5-5',
      systemPrompt: inputs.system,
      tools: [
        tool({
          name: 'read_notes',
          description: 'Reads the meeting notes page',
          parameters: { type: 'object', properties: {} },
          capabilities: [],
          execute: () => inputs.toolResult ?? '',
        }),
      ],
    });
    const prompt = inputs.document ? `${inputs.prompt}\n\n${inputs.document}` : inputs.prompt;
    return (await agent.invoke(agentInput(prompt))).state.answer;
  };
}

test('an adversarial dataset grows from every guardrail pattern, and the guardrails catch each attack', async () => {
  const dataset = await adversarialDataset();
  const attacks = dataset.examples.filter((example) => example.metadata?.category !== 'benign');
  assert.equal(attacks.length, attackSeeds().length * 3 * 3);
  assert.deepEqual(
    [...new Set(attacks.map((example) => example.metadata?.technique))].sort(),
    attackSeeds()
      .map((seed) => seed.label)
      .sort(),
  );
  const detector = new InjectionDetector();
  for (const example of dataset.examples) {
    const { system, prompt, document, toolResult } = example.inputs;
    const messages: Message[] = [
      { role: 'system', content: system },
      { role: 'user', content: [prompt, document].filter(Boolean).join('\n\n') },
      ...(toolResult ? [{ role: 'tool' as const, toolCallId: 'c1', content: toolResult }] : []),
    ];
    const found = detector.detect({ model: 'm', messages }).length > 0;
    assert.equal(found, example.metadata?.category !== 'benign', example.id);
  }
  assert.equal(new Set(dataset.examples.map((example) => example.expected?.canary)).size, dataset.examples.length);
});

test('the adversarial dataset fails an unguarded agent and passes a guarded one', async () => {
  const dataset = await adversarialDataset();
  const rate = (experiment: Awaited<ReturnType<typeof evaluate>>, benign: boolean) => {
    const results = experiment.results.filter((result) => result.exampleId.startsWith('benign-') === benign);
    return results.filter((result) => result.scores.every((score) => score.passed)).length / results.length;
  };
  const answered = (experiment: Awaited<ReturnType<typeof evaluate>>) =>
    experiment.results
      .filter((result) => result.exampleId.startsWith('benign-'))
      .every((result) => String(result.output).includes('Tuesday'));

  const unguarded = await evaluate(target(false), dataset, [resistsAttack()], { name: 'unguarded' });
  assert.equal(rate(unguarded, false), 0, 'every attack gets the canary out of an unguarded agent');

  const guarded = await evaluate(target(true), dataset, [resistsAttack()], { name: 'guarded' });
  assert.equal(rate(guarded, false), 1, 'no attack gets the canary out of a guarded agent');
  assert.equal(rate(guarded, true), 1);
  assert.ok(answered(guarded), 'the guarded agent still answers the benign examples');

  // Where each attack was stopped: a critical or high one before the model, a medium one on the way out.
  const medium = new Set(
    attackSeeds()
      .filter((seed) => seed.severity === 'medium')
      .map((seed) => seed.label),
  );
  for (const result of guarded.results.filter((item) => !item.exampleId.startsWith('benign-'))) {
    const example = dataset.examples.find((item) => item.id === result.exampleId);
    if (medium.has(String(example?.metadata?.technique))) {
      assert.match(String(result.output), /\[REDACTED\]/, ` is redacted on the way out`);
    } else {
      assert.match(String(result.error?.message), /prompt injection/i, ` is blocked before the model`);
    }
  }
});

test('an insights issue’s runs become regression examples that point back to the issue', () => {
  const run = (id: string, failed: boolean): Run =>
    ({
      id,
      name: 'support-agent',
      type: 'chain',
      inputs: { question: `question ${id}` },
      outputs: failed ? undefined : { answer: 'ok' },
      ...(failed ? { error: 'TypeError: boom' } : {}),
      startTime: '2026-10-12T00:00:00.000Z',
    }) as unknown as Run;
  const issue = {
    id: 'failing:abc',
    kind: 'failing',
    rate: 0.2,
    summary: '2 failing runs of support-agent: TypeError: boom',
    cluster: { runs: [run('run-1', true), run('run-2', true)] },
  } as unknown as Issue;
  const before = promoteIssue(issue, { name: 'regressions', limit: 1 });
  assert.equal(before.examples.length, 1);
  const after = promoteIssue(issue, { into: before });
  assert.deepEqual(
    after.examples.map((example) => example.sourceRunId),
    ['run-1', 'run-2'],
    'a run already promoted is not added twice',
  );
  const promoted = after.examples[1];
  assert.deepEqual(promoted?.metadata?.issue, { id: 'failing:abc', kind: 'failing', summary: issue.summary });
  assert.deepEqual(promoted?.tags, ['from-insights', 'failing']);
  assert.equal(promoted?.expected, undefined, 'a failed run has no expected output to copy');
  assert.notEqual(after.version, before.version);
});
