import {
  NexusAI,
  supportTriageWorkflow,
  salesQualificationWorkflow,
  legalReviewWorkflow,
  codeReviewWorkflow,
} from 'nexus-ai-pro';

const ai = new NexusAI({
  providers: {
    ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },
  },
  routing: { mode: 'auto', strategy: 'privacy' },
});

console.log(
  await supportTriageWorkflow(ai, {
    model: 'auto',
    input: 'Customer cannot log in after enabling SSO.',
    customerTier: 'enterprise',
  }),
);

console.log(
  await salesQualificationWorkflow(ai, {
    model: 'auto',
    input: 'Lead needs secure AI routing for a healthcare app.',
    product: 'nexus-ai-pro',
  }),
);

console.log(
  await legalReviewWorkflow(ai, {
    model: 'auto',
    input: 'Draft contract clause text...',
    jurisdiction: 'US',
  }),
);

console.log(
  await codeReviewWorkflow(ai, {
    model: 'auto',
    input: 'function add(a,b){ return a-b }',
    language: 'JavaScript',
  }),
);
