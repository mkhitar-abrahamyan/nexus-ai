import { createNexusConfig } from 'nexus-ai-pro';

const ai = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY || 'dev-key')
  .deepseek(process.env.DEEPSEEK_API_KEY || 'dev-key')
  .lmstudio({ baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1' })
  .auto('cost')
  .security('standard')
  .retry({ enabled: true, maxRetries: 2 })
  .logger({
    console: false,
    sink: (event) => {
      console.log(JSON.stringify(event));
    },
  })
  .create();

console.log(ai.listProviders());
