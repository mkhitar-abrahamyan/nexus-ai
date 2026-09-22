import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmNeedsShell = !npmCli && process.platform === 'win32';
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCache = path.join(repoRoot, '.tmp-nexus-ai-tests', 'npm-cache');
const tempParent = path.resolve(repoRoot, '..', '.tmp-nexus-ai-tests');
mkdirSync(npmCache, { recursive: true });
mkdirSync(tempParent, { recursive: true });
const tempRoot = mkdtempSync(path.join(tempParent, 'type-consumer-'));
const packDir = path.join(tempRoot, 'pack');
const consumerDir = path.join(tempRoot, 'consumer');
mkdirSync(packDir);
mkdirSync(consumerDir);
let keepTempDir = false;

function npmEnv() {
  return {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_cache: npmCache,
    npm_config_fetch_retries: '1',
    npm_config_fetch_timeout: '30000',
    npm_config_fund: 'false',
    npm_config_prefer_offline: 'true',
    npm_config_dry_run: 'false',
  };
}

function run(command, args, cwd, options = {}) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: npmEnv(),
    ...options,
  });
}

function runNpm(args, cwd, options = {}) {
  run(npmCommand, npmCli ? [npmCli, ...args] : args, cwd, {
    shell: npmNeedsShell,
    ...options,
  });
}

try {
  const packOutput = execFileSync(
    npmCommand,
    npmCli
      ? [npmCli, 'pack', '--json', '--pack-destination', packDir]
      : ['pack', '--json', '--pack-destination', packDir],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: npmEnv(),
      shell: npmNeedsShell,
    },
  );
  const [packed] = JSON.parse(packOutput);
  const tarball = path.join(packDir, packed.filename);

  runNpm(['init', '-y'], consumerDir);
  runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumerDir);

  writeFileSync(
    path.join(consumerDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          lib: ['ES2022'],
          types: ['node'],
        },
        include: ['index.ts'],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    path.join(consumerDir, 'index.ts'),
    `
import {
  AnthropicProvider,
  BaseProvider,
  AzureOpenAIProvider,
  CohereProvider,
  ContextWindowManager,
  DeepSeekProvider,
  GoogleProvider,
  GroqProvider,
  EmbeddingManager,
  BatchManager,
  CircuitBreaker,
  MemoryOperationStore,
  MemoryRateLimitStore,
  OperationRunner,
  ImageManager,
  LMStudioProvider,
  LlamaCppProvider,
  MemoryCache,
  MistralProvider,
  NexusAI,
  NexusProviderError,
  OllamaProvider,
  OpenRouterProvider,
  TelephonyManager,
  LLMJudge,
  VoiceSession,
  VoiceManager,
  createNexus,
  createNexusConfig,
  defineNexusConfig,
  type CreateCallRequest,
  type CreateNexusOptions,
  type AssetStore,
  type CompletionRequest,
  type ContextWindowConfig,
  type CostBudgetConfig,
  type DeepSeekProviderConfig,
  type DurableOperationHandle,
  type EmbeddingConfig,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type EmbeddingsProvider,
  type ImageConfig,
  type BatchJobRef,
  type BatchJobResult,
  type CircuitState,
  type OperationRecord,
  type RateLimitStore,
  type OperationStore,
  type ImageGenerateRequest,
  type ImageProvider,
  type ImageResult,
  type LoggerConfig,
  type NexusAIConfig,
  type NexusResponse,
  type NexusStream,
  type OpenAIProviderConfig,
  type ProvidersConfig,
  type ResponseMeta,
  type RetryConfig,
  type RoutingConfig,
  type SpeechRequest,
  type StreamChunk,
  type TelephonyConfig,
  type TelephonyProvider,
  type TelephonyResponseRequest,
  type TranscriptionRequest,
  type ToolCall,
  type VoiceConfig,
  type VoiceProvider,
  type VoiceSessionConfig,
} from 'nexus-ai-pro';
import { createNexusConfig as createSubpathNexusConfig } from 'nexus-ai-pro/config';
import { OpenAIProvider } from 'nexus-ai-pro/providers/openai';
import { NexusProviderError as SubpathProviderError } from 'nexus-ai-pro/providers/errors';
import { MemoryCache as SubpathMemoryCache } from 'nexus-ai-pro/cache/memory-cache';
import { ContextWindowManager as SubpathContextWindowManager } from 'nexus-ai-pro/context';
import { VoiceManager as SubpathVoiceManager } from 'nexus-ai-pro/voice';
import { OpenAIVoiceProvider } from 'nexus-ai-pro/voice/openai';
import { VoiceSession as SubpathVoiceSession } from 'nexus-ai-pro/voice/session';
import { ImageManager as SubpathImageManager } from 'nexus-ai-pro/images';
import { MemoryAssetStore } from 'nexus-ai-pro/images/assets';
import { MockImageProvider } from 'nexus-ai-pro/images/mock';
import { OpenAIImageProvider } from 'nexus-ai-pro/images/openai';
import { GoogleImageProvider } from 'nexus-ai-pro/images/google';
import { ComfyUIImageProvider, comfyInpaintWorkflow } from 'nexus-ai-pro/images/comfyui';
import { PngMaskTransformer, type AssetTransformer } from 'nexus-ai-pro/images/transform';
import { createImageInputResolver } from 'nexus-ai-pro/images/inputs';
import { combineSafetyPolicies, createOpenAIVisualModeration } from 'nexus-ai-pro/images/moderation';
import { MediaEvalRunner, MemoryReviewQueue } from 'nexus-ai-pro/images/evals';
import type { MediaEvalReport } from 'nexus-ai-pro/images/evals';
import { createGraph, MemoryGraphCheckpointer, appendList, counter, END, Send, Command } from 'nexus-ai-pro/graph';
import type { GraphDescription, GraphEvent, GraphResult, GraphTask, NodeOptions, RetryPolicy } from 'nexus-ai-pro/graph';
import { toMermaid } from 'nexus-ai-pro/graph/visualize';
import { createAgent, agentInput, type AgentMiddleware, type AgentState } from 'nexus-ai-pro/agent';
import { MemoryStore, type Store, type StoreItem } from 'nexus-ai-pro/store';
import { RedisStore } from 'nexus-ai-pro/store/redis';
import { McpClient, McpServer, type McpTransport } from 'nexus-ai-pro/mcp';
import { Tracer, MemoryTraceStore, traceGraph, AlertEvaluator, type Run, type TraceStore } from 'nexus-ai-pro/tracing';
import {
  evaluate,
  createDataset,
  compareExperiments,
  exactMatch,
  passRate,
  AnnotationQueue,
  MemoryExperimentStore,
  FileExperimentStore,
  underCost,
  type Experiment,
} from 'nexus-ai-pro/evaluate';
import {
  PostgresOperationStore,
  PostgresStore,
  PostgresTraceStore,
  PostgresDatasetStore,
  PostgresExperimentStore,
  PostgresCircuitStateStore,
  postgresMigration,
  type PostgresLikeClient,
} from 'nexus-ai-pro/postgres';
import { PostgresStore as SubpathPostgresStore } from 'nexus-ai-pro/postgres/store';
import { PostgresPromptStore } from 'nexus-ai-pro/postgres/prompts';
import { definePrompt, type PromptVersion, type RenderedPrompt } from 'nexus-ai-pro/prompts';
import { PromptClient } from 'nexus-ai-pro/prompts/client';
import { PromptRegistry, experimentGate, servedByGate, evaluatePrompt, formatPromptDiff } from 'nexus-ai-pro/prompts/registry';
import { FilePromptStore } from 'nexus-ai-pro/prompts/file';
import { RedisPromptStore } from 'nexus-ai-pro/prompts/redis';
import { MemoryCircuitStateStore, RedisCircuitStateStore } from 'nexus-ai-pro/ops/circuit-store';
import { recordingFetch, replayFetch, type RecordedExchange } from 'nexus-ai-pro/testing/record';
import { BatchManager as SubpathBatchManager } from 'nexus-ai-pro/batch';
import { MockBatchProvider } from 'nexus-ai-pro/batch/mock';
import { OpenAIBatchProvider } from 'nexus-ai-pro/batch/openai';
import { AnthropicBatchProvider } from 'nexus-ai-pro/batch/anthropic';
import { FilesystemAssetStore, S3AssetStore } from 'nexus-ai-pro/images/stores';
import { CircuitBreaker as SubpathCircuitBreaker } from 'nexus-ai-pro/ops/circuit-breaker';
import { RedisRateLimitStore } from 'nexus-ai-pro/ops/rate-limit-adapters';
import { OperationRunner as SubpathOperationRunner } from 'nexus-ai-pro/operations';
import { RedisOperationStore } from 'nexus-ai-pro/operations/adapters';
import { verifyOperationWebhook } from 'nexus-ai-pro/operations/webhooks';
import { EmbeddingManager as SubpathEmbeddingManager } from 'nexus-ai-pro/embeddings';
import { MockEmbeddingProvider } from 'nexus-ai-pro/embeddings/mock';
import { OpenAIEmbeddingProvider } from 'nexus-ai-pro/embeddings/adapters';
import { resolveEmbeddingModel } from 'nexus-ai-pro/embeddings/models';
import { TelephonyManager as SubpathTelephonyManager } from 'nexus-ai-pro/telephony';
import { TwilioTelephonyProvider } from 'nexus-ai-pro/telephony/twilio';
import { LLMJudge as SubpathLLMJudge } from 'nexus-ai-pro/evals/judge';
import {
  MockRealtimeTransport,
  OpenAIRealtimeProvider,
  createRealtimeAgent,
  createRealtimeSession,
  defineTool as defineRealtimeTool,
  type RealtimeConversation,
  type RealtimeEvent,
  type RealtimeToolCall,
} from 'nexus-ai-pro/realtime';
import { RealtimeSession as SubpathRealtimeSession } from 'nexus-ai-pro/realtime/session';
import { RealtimeToolExecutor } from 'nexus-ai-pro/realtime/tools';
import { createRealtimeConversation } from 'nexus-ai-pro/realtime/conversation';
import { OpenAIWebRTCTransport } from 'nexus-ai-pro/realtime/openai-webrtc';
import { OpenAIWebSocketTransport } from 'nexus-ai-pro/realtime/openai-websocket';
import { createOpenAIRealtimeSessionEndpoint } from 'nexus-ai-pro/realtime/openai-server';
import { MockRealtimeTransport as DirectMockRealtimeTransport } from 'nexus-ai-pro/realtime/mock';

class ConsumerProvider extends BaseProvider {
  readonly info = { name: 'consumer', isLocal: true };

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    return {
      ...this.createBaseResponse('consumer', request.model),
      content: 'ok',
    };
  }

  stream(): NexusStream {
    return this.createStream(async function* () {
      yield { type: 'text', content: 'ok' } satisfies StreamChunk;
      yield { type: 'done' } satisfies StreamChunk;
    });
  }
}

const voiceProvider: VoiceProvider = {
  info: { name: 'consumer-voice', supports: { transcription: true, speech: true } },
  async transcribe(request: TranscriptionRequest) {
    return { text: 'hello', providerUsed: 'consumer-voice', modelUsed: request.model };
  },
  async speak(request: SpeechRequest) {
    return {
      audio: { data: new Uint8Array([1]), format: request.format || 'mp3' },
      providerUsed: 'consumer-voice',
      modelUsed: request.model,
      format: request.format || 'mp3',
    };
  },
};

const telephonyProvider: TelephonyProvider = {
  info: { name: 'consumer-phone', supports: { inbound: true, outbound: true, mediaStreams: true } },
  async createCall(request: CreateCallRequest) {
    return {
      callId: 'call',
      providerUsed: 'consumer-phone',
      status: 'queued',
      direction: 'outbound',
      to: request.to,
      from: request.from,
    };
  },
  async createWebhookResponse(request: TelephonyResponseRequest) {
    return {
      providerUsed: 'consumer-phone',
      contentType: 'text/xml',
      body: request.say ? '<Response><Say>ok</Say></Response>' : '<Response/>',
    };
  },
};

const controller = new AbortController();
const realtimeTool = defineRealtimeTool({
  name: 'check_availability',
  description: 'Check availability for a date.',
  parameters: {
    type: 'object',
    properties: { date: { type: 'string' } },
    required: ['date'],
  },
  execute: async (input: { date: string }, context) => ({
    available: Boolean(input.date),
    idempotencyKey: context.idempotencyKey,
  }),
  safe: true,
});
const realtimeTransport = new MockRealtimeTransport({ autoPlay: false });
const realtimeSession = createRealtimeSession({
  model: 'gpt-realtime',
  transport: realtimeTransport,
  tools: [realtimeTool],
  interruption: { enabled: true, truncateUnheardAudio: true },
});
const directRealtimeSession: SubpathRealtimeSession = realtimeSession;
const realtimeProvider = new OpenAIRealtimeProvider({ sessionEndpoint: '/api/realtime/session' });
const realtimeAgent = createRealtimeAgent({
  provider: realtimeProvider,
  model: 'gpt-realtime',
  tools: [realtimeTool],
  voice: { transport: realtimeTransport, turnDetection: { type: 'server_vad' }, interruption: true },
});
const realtimeConversation: RealtimeConversation = createRealtimeConversation({
  provider: 'openai',
  model: 'gpt-realtime',
});
const realtimeToolCall: RealtimeToolCall = {
  callId: 'call_1',
  name: 'check_availability',
  arguments: { date: '2026-07-17' },
  idempotencyKey: 'idem_1',
};
const realtimeExecutor = new RealtimeToolExecutor([realtimeTool], {
  sessionId: 'session_1',
  signal: controller.signal,
});
const realtimeWebRTC = new OpenAIWebRTCTransport({ sessionEndpoint: '/api/realtime/session' });
const realtimeWebSocket = new OpenAIWebSocketTransport({ ephemeralToken: 'ephemeral' });
const directMockRealtime = new DirectMockRealtimeTransport();
const realtimeEndpoint = createOpenAIRealtimeSessionEndpoint({
  apiKey: 'server-only',
  model: 'gpt-realtime',
});
const unsubscribeRealtime = realtimeSession.on('conversation.updated', (snapshot) => {
  const conversationId: string = snapshot.id;
  void conversationId;
});
realtimeSession.on('speech.started', (event: Extract<RealtimeEvent, { type: 'speech.started' }>) => {
  void event.timestamp;
});
const request: CompletionRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hello' }],
  signal: controller.signal,
};

const providersConfig: ProvidersConfig = {
  openai: { apiKey: 'test' },
  anthropic: { apiKey: 'test' },
  google: { apiKey: 'test' },
  ollama: { baseUrl: 'http://localhost:11434' },
  groq: { apiKey: 'test' },
  mistral: { apiKey: 'test' },
  cohere: { apiKey: 'test' },
  openrouter: { apiKey: 'test', appName: 'consumer', siteUrl: 'https://example.com' },
  deepseek: { apiKey: 'test' },
  azureOpenAI: {
    apiKey: 'test',
    endpoint: 'https://example.openai.azure.com',
    deployment: 'chat',
  },
  lmstudio: { baseUrl: 'http://localhost:1234/v1' },
  llamaCpp: { baseUrl: 'http://localhost:8080/v1' },
  custom: [{
    name: 'custom-openai',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test',
    format: 'openai',
  }],
};
const routingConfig: RoutingConfig = {
  mode: 'auto',
  strategy: 'quality',
  requiredCapabilities: { streaming: true, minContextTokens: 1000 },
};
const retryConfig: RetryConfig = {
  enabled: true,
  maxRetries: 1,
  retryOn: ['timeout', 'rate-limit', 'server-error', 'network'],
};
const costBudgetConfig: CostBudgetConfig = {
  enabled: true,
  maxEstimatedCost: 0.1,
  onExceeded: 'warn',
};
const contextWindowConfig: ContextWindowConfig = {
  strategy: 'last-messages-with-summary',
  lastMessages: 8,
  summary: {
    model: 'consumer/summary',
    maxTokens: 256,
  },
};
const voiceConfig: VoiceConfig = {
  defaultTranscriptionProvider: 'consumer-voice',
  defaultSpeechProvider: 'consumer-voice',
  providers: { 'consumer-voice': voiceProvider },
};
const voiceSessionConfig: VoiceSessionConfig = {
  model: 'consumer/test',
  prompt: 'Answer as a phone assistant.',
  instructions: ['Be concise.'],
  taskPrompts: [{
    name: 'booking',
    when: ['booking', /slot/i],
    instructions: 'Check free slots when asked about bookings.',
    tools: ['check_free_slots'],
  }],
  tools: [{
    name: 'check_free_slots',
    description: 'Check free booking slots.',
    parameters: { type: 'object', properties: { date: { type: 'string' } } },
    execute: async () => ({ slots: ['10:00'] }),
  }],
  toolSelection: 'task',
  speech: { provider: 'consumer-voice', format: 'mp3' },
};
const embeddingConfigProvider: EmbeddingsProvider = new MockEmbeddingProvider();
const embeddingConfig: EmbeddingConfig = {
  providers: { mock: embeddingConfigProvider },
  defaultProvider: 'mock',
  cache: { enabled: true, ttlSeconds: 60 },
  costBudget: { enabled: true, maxEstimatedCost: 1 },
};
const mockImageProvider: ImageProvider = new MockImageProvider({ model: 'mock-image-v1' });
const imageConfig: ImageConfig = {
  defaultProvider: 'mock',
  providers: { mock: mockImageProvider },
};
const imageRequest: ImageGenerateRequest = {
  model: 'auto',
  prompt: 'A blue square.',
  delivery: { kind: 'bytes', format: 'png' },
};
const telephonyConfig: TelephonyConfig = {
  defaultProvider: 'consumer-phone',
  providers: { 'consumer-phone': telephonyProvider },
};
const aiConfig: NexusAIConfig = {
  providers: providersConfig,
  routing: routingConfig,
  retry: retryConfig,
  costBudget: costBudgetConfig,
  contextWindow: contextWindowConfig,
  voice: voiceConfig,
  images: imageConfig,
  embeddings: embeddingConfig,
  telephony: telephonyConfig,
  defaultModel: 'consumer/test',
  security: 'off',
};

const ai = new NexusAI({
  providers: {},
  routing: { mode: 'direct' },
  defaultModel: 'consumer/test',
})
  .registerProvider('consumer', new ConsumerProvider())
  .registerImageProvider('mock', mockImageProvider);
const simpleOptions: CreateNexusOptions = {
  provider: 'openai',
  apiKey: 'test',
  model: 'gpt-5.4-mini',
  security: 'off',
};
const simpleAi = createNexus(simpleOptions);
const builderConfig = createNexusConfig()
  .openai('test')
  .deepseek({ apiKey: 'test' })
  .lmstudio()
  .custom({ name: 'custom-openai', baseUrl: 'https://example.test/v1', format: 'openai' })
  .images(imageConfig)
  .direct('custom-openai/model')
  .security('off')
  .build();
const builtAi = createSubpathNexusConfig(builderConfig).create();
const literalConfig = defineNexusConfig({
  providers: { openai: { apiKey: 'test' } },
  routing: { mode: 'direct' },
  defaultModel: 'gpt-5.4-mini',
});
const literalAi = createNexus(literalConfig);

const responsePromise: Promise<NexusResponse> = ai.complete(request);
const exactCache = new MemoryCache<NexusResponse>();
const subpathCache = new SubpathMemoryCache<string>();
const contextManager = new ContextWindowManager(contextWindowConfig);
const subpathContextManager = new SubpathContextWindowManager(contextWindowConfig);
const voiceManager = new VoiceManager(voiceConfig);
const subpathVoiceManager = new SubpathVoiceManager(voiceConfig);
const voiceSession: VoiceSession = ai.createVoiceSession(voiceSessionConfig);
const subpathVoiceSession = new SubpathVoiceSession(voiceSessionConfig, subpathVoiceManager, ai);
const openAiVoice = new OpenAIVoiceProvider({ apiKey: 'test' });
const demoGraph = createGraph({ channels: { log: appendList<string>(), turns: counter() } })
  .addNode('think', () => ({ log: ['thought'], turns: 1 }))
  .setEntry('think')
  .addConditionalEdges('think', (state) => (state.turns >= 2 ? END : 'think'))
  .compile({ checkpointer: new MemoryGraphCheckpointer() });
const graphRun: Promise<GraphResult<{ log: ReturnType<typeof appendList<string>>; turns: ReturnType<typeof counter> }>> =
  demoGraph.invoke({}, { threadId: 'consumer-thread', maxConcurrency: 4 });
const nodeRetry: NodeOptions = { retry: { maxAttempts: 3 } satisfies RetryPolicy, timeoutMs: 5_000, ends: [END] };
const fanOutGraph = createGraph({ channels: { log: appendList<string>(), turns: counter() } })
  .addNode('plan', () => ({ turns: 1 }))
  .addNode('each', (ctx) => ({ log: [String(ctx.input)], turns: ctx.attempt }), nodeRetry)
  .setEntry('plan')
  .addConditionalEdges('plan', () => [new Send('each', 'a'), new Send('each', 'b')])
  .compile({ maxConcurrency: 8, onNodeError: 'settle', retry: { maxAttempts: 2 } });
const fanOutTasks: Promise<GraphTask[] | undefined> = fanOutGraph
  .state('consumer-fanout')
  .then((checkpoint) => checkpoint?.tasks);
const answered = fanOutGraph.resumeInterruptsWith('consumer-fanout', { 'each#2.0:1:0': true });
const routedGraph = createGraph({ channels: { log: appendList<string>(), turns: counter() } })
  .addNode('decide', () => new Command({ update: { turns: 1 }, goto: 'act' }), { ends: ['act'] })
  .addNode('act', () => ({ log: ['acted'] }), { defer: true })
  .setEntry('decide')
  .addEdge('act', END)
  .compile({ interruptBefore: ['act'] });
const shape: GraphDescription = routedGraph.describe();
const diagram: string = toMermaid(shape, { direction: 'LR', highlight: ['act'] });
const edited = routedGraph.updateState('consumer-thread', { turns: 1 }, { asNode: 'decide' });
const forked: Promise<string> = routedGraph.fork('consumer-thread', { step: 0 });
const listened = routedGraph.invoke({}, { onEvent: (event: GraphEvent) => void event.type });
const memoryStore: Store = new MemoryStore({ maxItems: 100 });
const storedItem: Promise<StoreItem<{ text: string }> | undefined> = memoryStore.get(['users', 'a'], 'tone') as never;
const redisStore = new RedisStore({} as never, { prefix: 'app' });
const agentMiddleware: AgentMiddleware = { afterModel: ({ state }: { state: AgentState }) => void state.iterations };
const typedAgent = createAgent({
  client: { complete: async () => ({}) as never },
  tools: [],
  store: memoryStore,
  middleware: [agentMiddleware],
  interruptOn: { send_email: true },
});
const agentRun = typedAgent.invoke(agentInput('hello'), { threadId: 'consumer-agent' });
const mcpTransport: McpTransport = { send: () => undefined, onMessage: () => undefined, close: () => undefined };
const mcpClient = new McpClient(mcpTransport);
const mcpTools = mcpClient.toNexusTools({ prefix: 'files' });
const mcpServer = new McpServer({ name: 'consumer' });
const traceStore: TraceStore = new MemoryTraceStore({ maxRuns: 500 });
const tracer = new Tracer({ store: traceStore, sampling: { rate: 0.1, keepErrors: true }, redaction: { hideFields: ['apiKey'] } });
const traced: Promise<string> = tracer.trace({ name: 'demo', kind: 'chain' }, () => 'ok');
const graphTracing = traceGraph(tracer, { name: 'demo-graph' });
const alerts = new AlertEvaluator(traceStore, [{ name: 'errors', metric: 'errorRate', threshold: 0.1 }]);
const firstRun: Promise<Run | undefined> = Promise.resolve(traceStore.query({ limit: 1 })).then((runs) => runs[0]);
const evalDataset = createDataset<{ q: string }, string>({
  name: 'consumer',
  examples: [{ inputs: { q: 'hi' }, expected: 'hello' }],
});
const experiment: Promise<Experiment> = evaluate(async (inputs) => inputs.q, evalDataset, [exactMatch()], {
  summary: [passRate()],
  store: new MemoryExperimentStore(),
  repetitions: 2,
});
const comparison = experiment.then((candidate) => compareExperiments(candidate, candidate));
const pool: PostgresLikeClient = { query: async () => ({ rows: [], rowCount: 0 }) };
const durableOperations = new PostgresOperationStore(pool, { table: 'app.operations' });
const postgresMemory: Store = new PostgresStore(pool, { vectorDimensions: 1536 });
const subpathMemoryStore: Store = new SubpathPostgresStore(pool);
const postgresTraces: TraceStore = new PostgresTraceStore(pool);
const postgresDatasets = new PostgresDatasetStore(pool);
const postgresExperiments = new PostgresExperimentStore(pool);
const sharedCircuits = new PostgresCircuitStateStore(pool);
const triage = definePrompt({
  name: 'triage',
  messages: [
    { role: 'system', content: 'Triage for {{team}}.' },
    { placeholder: 'history', optional: true },
    { role: 'user', content: '{{ticket.body}}' },
  ],
  defaults: { team: 'support' },
  config: { model: 'gpt-5.4-mini' },
});
const triageRequest: RenderedPrompt = triage.render({ ticket: { body: 'down' } });
// @ts-expect-error a variable without a default is required
triage.render({ team: 'billing' });
const promptRegistry = new PromptRegistry({
  store: new PostgresPromptStore(pool),
  gates: { production: [servedByGate('staging'), experimentGate({ store: new MemoryExperimentStore(), thresholds: { correctness: 0.9 } })] },
});
const committed: Promise<PromptVersion> = promptRegistry.commit(triage, { label: 'staging' });
const promptClient = new PromptClient({ source: promptRegistry.store, ttlMs: 30_000, fallbacks: [triage] });
const served: Promise<RenderedPrompt> = promptClient.render('triage', { ticket: { body: 'x' } }, { key: 'user-1' });
const promptFiles = new FilePromptStore('./prompts');
const promptRedis = new RedisPromptStore({
  hsetnx: async () => 1, hset: async () => 1, hget: async () => null, hvals: async () => [], hdel: async () => 1,
  lpush: async () => 1, lrange: async () => [], ltrim: async () => 'OK', sadd: async () => 1, smembers: async () => [],
});
void [triageRequest, committed, served, promptFiles, promptRedis, evaluatePrompt, formatPromptDiff];
const schema: string = postgresMigration({ adapters: ['traces', 'circuits'] });
const sharedBreaker = new CircuitBreaker({ enabled: true, store: new MemoryCircuitStateStore(), workerId: 'api-1' });
const redisCircuits = new RedisCircuitStateStore({
  hgetall: async () => ({}),
  hget: async () => null,
  hset: async () => 1,
  set: async () => 'OK',
  get: async () => null,
  del: async () => 1,
});
const experimentFiles = new FileExperimentStore('./experiments');
const costGate = underCost(0.05);
const recorder = recordingFetch({ directory: './fixtures' });
const replayer: typeof fetch = replayFetch({ directory: './fixtures', onMissing: 'throw' });
const exchangeKey = (exchange: RecordedExchange): string => exchange.key;
const reviewQueue = new AnnotationQueue({ rubric: [{ key: 'ok', prompt: 'Good?', type: 'boolean' }] });
const batchManager = new BatchManager({ providers: { mock: new MockBatchProvider() }, defaultProvider: 'mock' });
const subpathBatchManager = new SubpathBatchManager();
const openAiBatch = new OpenAIBatchProvider({ apiKey: 'test' });
const anthropicBatch = new AnthropicBatchProvider({ apiKey: 'test' });
const batchRef: BatchJobRef = { id: 'batch-1', provider: 'mock' };
const batchResult: Promise<BatchJobResult> = batchManager.resume(batchRef);
const fileStore: AssetStore = new FilesystemAssetStore({ directory: './assets' });
const rateLimitStore: RateLimitStore = new MemoryRateLimitStore();
const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 3 });
const subpathBreaker = new SubpathCircuitBreaker({ enabled: true });
const breakerState: CircuitState = breaker.state('openai');
const operationStore: OperationStore<string> = new MemoryOperationStore<string>();
const operationRunner = new OperationRunner<string>({ store: operationStore, retry: { maxAttempts: 2 } });
const subpathOperationRunner = new SubpathOperationRunner<string>();
const operationHandle: Promise<DurableOperationHandle<string>> = operationRunner.submit(async () => 'ok');
const operationRecord: Promise<OperationRecord<string> | undefined> = operationRunner.read('op-1');
const webhookOk: boolean = verifyOperationWebhook('{}', 't=1,v1=aa', 'secret');
const embeddingManager = new EmbeddingManager(embeddingConfig);
const subpathEmbeddingManager = new SubpathEmbeddingManager(embeddingConfig);
const openAiEmbeddings = new OpenAIEmbeddingProvider({ apiKey: 'test' });
const embeddingRequest: EmbeddingRequest = { input: ['one', 'two'], inputType: 'document', normalize: true };
const embeddingResponse: Promise<EmbeddingResponse> = ai.embed(embeddingRequest);
const embeddingVector: Promise<number[]> = ai.embedOne('one');
const resolvedEmbeddingModel = resolveEmbeddingModel('embed-quality');
const imageManager = new ImageManager(imageConfig);
const subpathImageManager = new SubpathImageManager(imageConfig);
const openAiImages = new OpenAIImageProvider({ apiKey: 'test' });
const maskTransformer: AssetTransformer = new PngMaskTransformer({ threshold: 128 });
const googleImages = new GoogleImageProvider({ apiKey: 'test', maskTransformer });
const comfyImages = new ComfyUIImageProvider({
  workflow: (request, context) => comfyInpaintWorkflow(request, context, 'sd-inpaint.safetensors'),
});
const portableImageManager = new SubpathImageManager({
  providers: { google: googleImages, comfyui: comfyImages },
  defaultProvider: 'google',
  inputResolver: createImageInputResolver({ maxPixels: 16_000_000 }),
  safety: combineSafetyPolicies(createOpenAIVisualModeration({ apiKey: 'test' })),
});
const mediaEvalReport: Promise<MediaEvalReport> = new MediaEvalRunner(
  (evalCase) => portableImageManager.generate(evalCase.request),
  { reviewQueue: new MemoryReviewQueue(), runs: 3 },
).evaluate([{ id: 'case', operation: 'generate', request: { prompt: 'a cat' }, expect: { minAlignment: 0.5 } }]);
const imageResult: Promise<ImageResult> = ai.images.generate(imageRequest);
const assetStore: AssetStore = new MemoryAssetStore({ maxEntries: 10, maxTotalBytes: 1_000_000 });
const telephonyManager = new TelephonyManager(telephonyConfig);
const subpathTelephonyManager = new SubpathTelephonyManager(telephonyConfig);
const twilioTelephony = new TwilioTelephonyProvider({ accountSid: 'AC123', authToken: 'test' });
const llmJudge = new LLMJudge({ client: ai, model: 'consumer/test', rubric: 'Score correctness.' });
const subpathJudge = new SubpathLLMJudge({ client: ai, model: 'consumer/test' });
const openAiConfig: OpenAIProviderConfig = { apiKey: 'test', organization: 'org' };
const deepSeekConfig: DeepSeekProviderConfig = { apiKey: 'test' };
const loggerConfig: LoggerConfig = {
  console: false,
  sink: (event) => {
    void event.level;
  },
};
const provider = new OpenAIProvider({ apiKey: 'test' });
const providerConstructors = [
  new OpenAIProvider(openAiConfig),
  new AnthropicProvider({ apiKey: 'test' }),
  new GoogleProvider({ apiKey: 'test' }),
  new OllamaProvider({ baseUrl: 'http://localhost:11434' }),
  new GroqProvider({ apiKey: 'test' }),
  new MistralProvider({ apiKey: 'test' }),
  new CohereProvider({ apiKey: 'test' }),
  new OpenRouterProvider({ apiKey: 'test', appName: 'consumer', siteUrl: 'https://example.com' }),
  new DeepSeekProvider(deepSeekConfig),
  new AzureOpenAIProvider({
    apiKey: 'test',
    endpoint: 'https://example.openai.azure.com',
    deployment: 'chat',
  }),
  new LMStudioProvider({ baseUrl: 'http://localhost:1234/v1' }),
  new LlamaCppProvider({ baseUrl: 'http://localhost:8080/v1' }),
];
const providerName: string = provider.info.name;
const error = new NexusProviderError({
  provider: 'consumer',
  model: 'consumer/test',
  message: 'failed',
  category: 'server-error',
});
const subpathError = new SubpathProviderError({
  provider: 'consumer',
  model: 'consumer/test',
  message: 'failed',
});
const toolCall: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'lookup', arguments: '{}' },
};
const meta: ResponseMeta = {
  requestId: 'req',
  providerUsed: 'consumer',
  modelUsed: 'consumer/test',
  latencyMs: 1,
  tokensInput: 1,
  tokensOutput: 1,
  tokensSaved: 0,
  estimatedCost: '$0.00',
  cacheHit: false,
  guardrailsApplied: [],
};
const doneChunk: StreamChunk = { type: 'done', meta };

void responsePromise;
void simpleAi;
void builtAi;
void literalAi;
void exactCache;
void subpathCache;
void contextManager;
void subpathContextManager;
void voiceManager;
void subpathVoiceManager;
void voiceSession;
void subpathVoiceSession;
void openAiVoice;
void imageManager;
void subpathImageManager;
void openAiImages;
void mediaEvalReport;
void imageResult;
void assetStore;
void telephonyManager;
void subpathTelephonyManager;
void twilioTelephony;
void llmJudge;
void subpathJudge;
void aiConfig;
void loggerConfig;
void providerConstructors;
void providerName;
void error.retryable;
void subpathError.category;
void toolCall;
void demoGraph;
void graphRun;
void batchManager;
void subpathBatchManager;
void openAiBatch;
void anthropicBatch;
void batchResult;
void fileStore;
void fanOutTasks;
void diagram;
void edited;
void forked;
void listened;
void storedItem;
void redisStore;
void agentRun;
void mcpTools;
void mcpServer;
void traced;
void graphTracing;
void alerts;
void firstRun;
void comparison;
void reviewQueue;
void answered;
void S3AssetStore;
void rateLimitStore;
void breaker;
void subpathBreaker;
void breakerState;
void RedisRateLimitStore;
void operationRunner;
void subpathOperationRunner;
void operationHandle;
void operationRecord;
void webhookOk;
void RedisOperationStore;
void embeddingManager;
void subpathEmbeddingManager;
void openAiEmbeddings;
void embeddingResponse;
void embeddingVector;
void resolvedEmbeddingModel;
void doneChunk;
void directRealtimeSession;
void realtimeAgent;
void realtimeConversation;
void realtimeToolCall;
void realtimeExecutor;
void realtimeWebRTC;
void realtimeWebSocket;
void directMockRealtime;
void realtimeEndpoint;
void unsubscribeRealtime;
`,
  );

  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', consumerDir], consumerDir);
  writeFileSync(
    path.join(consumerDir, 'tsconfig.browser.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
        },
        include: ['browser.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(consumerDir, 'browser.ts'),
    `
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';
import { OpenAIWebRTCTransport } from 'nexus-ai-pro/realtime/openai-webrtc';
import { definePrompt } from 'nexus-ai-pro/prompts';
import { PromptClient } from 'nexus-ai-pro/prompts/client';

// Templates and serving compile with browser types only: no Node API reaches either entry point.
const greeting = definePrompt({ name: 'greeting', messages: [{ role: 'user', content: 'Hello {{name}}' }] });
const browserPrompts = new PromptClient({
  source: { getLabel: async () => undefined, getVersion: async () => undefined },
  fallbacks: [greeting],
});
void [greeting.render({ name: 'Ada' }), browserPrompts.render('greeting', { name: 'Ada' }), greeting.version()];

const transport = new OpenAIWebRTCTransport({ sessionEndpoint: '/api/realtime/session' });
const session = createRealtimeSession({ model: 'gpt-realtime', transport });
const audioElement = document.createElement('audio');
const connection: Promise<void> = session.connect({ audioElement, microphone: true });
void connection;
`,
  );
  run(process.execPath, [tsc, '-p', path.join(consumerDir, 'tsconfig.browser.json')], consumerDir);
  console.log('TypeScript consumer compile test passed.');
} catch (error) {
  keepTempDir = true;
  console.error(`Type consumer fixture kept at ${tempRoot}`);
  throw error;
} finally {
  if (!keepTempDir) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
