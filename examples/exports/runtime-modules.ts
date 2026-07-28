import { MemoryCache } from 'nexus-ai-pro/cache/memory-cache';
import { SecurityPipeline } from 'nexus-ai-pro/security';
import { TokenOptimizer } from 'nexus-ai-pro/optimizer';
import { listKnownModels } from 'nexus-ai-pro/models';
import { ingestText } from 'nexus-ai-pro/rag';
import { EvalRunner } from 'nexus-ai-pro/evals';
import { JobQueue } from 'nexus-ai-pro/jobs';
import { runBatch } from 'nexus-ai-pro/jobs/batch';
import { summarizeVerifyFormat } from 'nexus-ai-pro/workflows';
import { VoiceManager } from 'nexus-ai-pro/voice';
import { ImageManager } from 'nexus-ai-pro/images';
import { MemoryAssetStore } from 'nexus-ai-pro/images/assets';
import { MockImageProvider } from 'nexus-ai-pro/images/mock';
import { TelephonyManager, createVoiceTwiML } from 'nexus-ai-pro/telephony';
import { createTextStream, collectStream } from 'nexus-ai-pro/streaming';

const cache = new MemoryCache<string>();
const security = new SecurityPipeline('standard');
const optimizer = new TokenOptimizer();
const voice = new VoiceManager();
const images = new ImageManager({ providers: { mock: new MockImageProvider() } });
const assets = new MemoryAssetStore({ maxEntries: 10, maxTotalBytes: 10_000_000 });
const telephony = new TelephonyManager();
const queue = new JobQueue(async (payload: string) => payload.toUpperCase());
const stream = createTextStream('hello');

cache.set('key', 'value');
const text = await collectStream(stream);

void security;
void optimizer;
void voice;
void images;
void assets;
void telephony;
void queue;
void EvalRunner;
void runBatch;
void summarizeVerifyFormat;
void ingestText;

console.log({
  cached: cache.get('key'),
  text,
  models: listKnownModels().length,
  twiml: createVoiceTwiML({ say: 'hello' }),
});
