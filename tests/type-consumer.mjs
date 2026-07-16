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
  type CompletionRequest,
  type ContextWindowConfig,
  type CostBudgetConfig,
  type DeepSeekProviderConfig,
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
import { TelephonyManager as SubpathTelephonyManager } from 'nexus-ai-pro/telephony';
import { TwilioTelephonyProvider } from 'nexus-ai-pro/telephony/twilio';
import { LLMJudge as SubpathLLMJudge } from 'nexus-ai-pro/evals/judge';

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
  telephony: telephonyConfig,
  defaultModel: 'consumer/test',
  security: 'off',
};

const ai = new NexusAI({
  providers: {},
  routing: { mode: 'direct' },
  defaultModel: 'consumer/test',
}).registerProvider('consumer', new ConsumerProvider());
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
void doneChunk;
`,
  );

  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', consumerDir], consumerDir);
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
