import { createNexusConfig } from 'nexus-ai-pro';

const ai = createNexusConfig()
  .custom({
    name: 'local-openai',
    baseUrl: process.env.LOCAL_OPENAI_BASE_URL || 'http://localhost:1234/v1',
    apiKey: process.env.LOCAL_OPENAI_API_KEY || 'local',
    format: 'openai',
    modelPrefix: 'local-openai',
    isLocal: true,
  })
  .direct('local-openai/local-model')
  .security('off')
  .create();

console.log(ai.listProviders());
