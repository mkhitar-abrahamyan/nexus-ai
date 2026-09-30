// @ts-check
/**
 * The assistants this deployment serves. Replace the example with your own graphs, agents, or
 * functions; `server.mjs` serves whatever this returns.
 *
 * Each assistant can have revisions. Ship the code for every revision you want to be able to run in
 * the image, then move traffic between them with the deployments API, the CLI, or the studio — no
 * rebuild needed to canary, promote, or roll back.
 */
import { functionAssistant } from 'nexus-ai-pro/server';

/** @param {import('nexus-ai-pro/server/deployments').Deployments} deployments */
export function defineAssistants(deployments) {
  return {
    support: deployments.assistant(
      'support',
      {
        // A real assistant calls a model here, through NexusAI, a graph, or an agent.
        '2026-09-01': functionAssistant(async (input) => ({ answer: `v1: ${JSON.stringify(input)}` })),
        '2026-09-30': functionAssistant(async (input) => ({ answer: `v2: ${JSON.stringify(input)}` })),
      },
      // The live revision until a deployment is recorded; after that, the recorded split decides.
      { live: '2026-09-01', description: 'Answers support questions' },
    ),
  };
}
