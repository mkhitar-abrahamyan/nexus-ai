import { TokenOptimizer } from 'nexus-ai-pro';

const optimizer = new TokenOptimizer({
  densification: {
    enabled: true,
    preserveCodeBlocks: true,
  },
  budget: {
    enabled: true,
    maxInputTokens: 120,
    warnAt: 0.7,
    onExceeded: 'densify',
  },
});

const request = {
  model: 'auto',
  messages: [
    {
      role: 'user' as const,
      content: `Please make sure that you explain this in a very detailed way.


      It is important to cover the following items:
        - what token optimization means
        - why it matters in order to reduce costs
        - how prompt densification works

      Please make sure that the final answer is concise.`,
    },
  ],
};

const result = optimizer.optimize(request);

console.log('Before tokens:', result.usage.beforeTokens);
console.log('After tokens:', result.usage.afterTokens);
console.log('Saved tokens:', result.usage.savedTokens);
console.log('Saved percent:', result.usage.savedPercent);
console.log('Techniques:', result.techniquesApplied);
console.log('Warnings:', result.warnings);
console.log('\nOptimized prompt:\n');
console.log(result.value.messages[0].content);
