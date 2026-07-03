import {
  NexusConfigBuilder,
  createNexusConfig,
  defineNexusConfig,
} from 'nexus-ai-pro/config';

const config = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY || 'dev-key')
  .deepseek(process.env.DEEPSEEK_API_KEY || 'dev-key')
  .lmstudio()
  .direct('gpt-5.4-mini')
  .security('standard')
  .build();

const sameConfig = defineNexusConfig(config);
const builder = new NexusConfigBuilder(sameConfig);

console.log(builder.build().defaultModel);
