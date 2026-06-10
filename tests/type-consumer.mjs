import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmNeedsShell = !npmCli && process.platform === 'win32';
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempDir = mkdtempSync(path.join(tmpdir(), 'nexus-ai-type-consumer-'));
let keepTempDir = false;

function run(command, args, cwd, options = {}) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
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
  const packOutput = execFileSync(npmCommand, npmCli
    ? [npmCli, 'pack', '--json', '--pack-destination', tempDir]
    : ['pack', '--json', '--pack-destination', tempDir], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: process.env,
    shell: npmNeedsShell,
  });
  const [packed] = JSON.parse(packOutput);
  const tarball = path.join(tempDir, packed.filename);

  runNpm(['init', '-y'], tempDir);
  runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], tempDir);

  writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify({
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
  }, null, 2));

  writeFileSync(path.join(tempDir, 'index.ts'), `
import {
  AnthropicProvider,
  BaseProvider,
  CohereProvider,
  ContextWindowManager,
  GoogleProvider,
  GroqProvider,
  MemoryCache,
  MistralProvider,
  NexusAI,
  NexusProviderError,
  OllamaProvider,
  OpenRouterProvider,
  VoiceManager,
  type CompletionRequest,
  type ContextWindowConfig,
  type CostBudgetConfig,
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
  type TranscriptionRequest,
  type ToolCall,
  type VoiceConfig,
  type VoiceProvider,
} from 'nexus-ai-pro';
import { OpenAIProvider } from 'nexus-ai-pro/providers/openai';
import { NexusProviderError as SubpathProviderError } from 'nexus-ai-pro/providers/errors';
import { MemoryCache as SubpathMemoryCache } from 'nexus-ai-pro/cache/memory-cache';
import { ContextWindowManager as SubpathContextWindowManager } from 'nexus-ai-pro/context';
import { VoiceManager as SubpathVoiceManager } from 'nexus-ai-pro/voice';
import { OpenAIVoiceProvider } from 'nexus-ai-pro/voice/openai';

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
const aiConfig: NexusAIConfig = {
  providers: providersConfig,
  routing: routingConfig,
  retry: retryConfig,
  costBudget: costBudgetConfig,
  contextWindow: contextWindowConfig,
  voice: voiceConfig,
  defaultModel: 'consumer/test',
  security: 'off',
};

const ai = new NexusAI({
  providers: {},
  routing: { mode: 'direct' },
  defaultModel: 'consumer/test',
}).registerProvider('consumer', new ConsumerProvider());

const responsePromise: Promise<NexusResponse> = ai.complete(request);
const exactCache = new MemoryCache<NexusResponse>();
const subpathCache = new SubpathMemoryCache<string>();
const contextManager = new ContextWindowManager(contextWindowConfig);
const subpathContextManager = new SubpathContextWindowManager(contextWindowConfig);
const voiceManager = new VoiceManager(voiceConfig);
const subpathVoiceManager = new SubpathVoiceManager(voiceConfig);
const openAiVoice = new OpenAIVoiceProvider({ apiKey: 'test' });
const openAiConfig: OpenAIProviderConfig = { apiKey: 'test', organization: 'org' };
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
void exactCache;
void subpathCache;
void contextManager;
void subpathContextManager;
void voiceManager;
void subpathVoiceManager;
void openAiVoice;
void aiConfig;
void providerConstructors;
void providerName;
void error.retryable;
void subpathError.category;
void toolCall;
void doneChunk;
`);

  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [tsc, '-p', tempDir], tempDir);
  console.log('TypeScript consumer compile test passed.');
} catch (error) {
  keepTempDir = true;
  console.error(`Type consumer fixture kept at ${tempDir}`);
  throw error;
} finally {
  if (!keepTempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
