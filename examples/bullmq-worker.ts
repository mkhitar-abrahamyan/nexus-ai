import { Queue, Worker } from 'bullmq';
import { NexusAI } from '../src/index.js';

// Optional example dependency install:
// npm install bullmq ioredis
// Start Redis before running this example.

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
};

const queueName = 'nexus-ai-pro-jobs';
const queue = new Queue(queueName, { connection });

const ai = new NexusAI({
  providers: {
    ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },
  },
  routing: { mode: 'auto', strategy: 'privacy' },
});

new Worker(queueName, async (job) => {
  const response = await ai.complete(job.data);
  return {
    content: response.content,
    meta: response.meta,
  };
}, { connection });

const job = await queue.add('completion', {
  model: 'auto',
  messages: [{ role: 'user', content: 'Summarize durable queues in one sentence.' }],
});

console.log(`Queued job ${job.id}`);
