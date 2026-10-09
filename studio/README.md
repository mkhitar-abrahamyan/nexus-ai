# nexus-ai-pro-studio

A studio for [nexus-ai-pro](https://www.npmjs.com/package/nexus-ai-pro): traces, threads, approvals,
experiments, prompts, context bundles, issues found in traces, proposed fixes, deployments and
canaries, costs, provider health, and the operation queue. It reads your application's own stores through the adapters it
already uses and needs no hosted service. It runs locally behind a token by default, or is shared by
a team with accounts, roles, an audit log, and comments.

```bash
npm install --save-dev nexus-ai-pro-studio
npx nexus-studio --config studio.config.mjs
```

```js
// studio.config.mjs — the default export is the studio's sources.
import { PostgresTraceStore } from 'nexus-ai-pro/postgres/traces';
import { pool, graph, checkpointer, registry, ai } from './src/app.js';

export default {
  traces: new PostgresTraceStore(pool),
  graphs: { support: { graph, checkpointer } },
  prompts: registry,
  client: ai,
};
```

Open the address it prints. Every source is optional; the studio shows a view for each one it is
given.

| View | What you can do |
| --- | --- |
| Traces | Filter runs, open run trees, compare two traces, record feedback |
| Threads | Graph diagrams, thread state at any step, fork, edit, and resume |
| Inbox | Threads waiting for a human, review items waiting for a grade, and proposed fixes |
| Issues | Failing and slow runs clustered, and what got worse than last week |
| Experiments | Compare two experiments with intervals and a verdict |
| Prompts | Versions, diffs, gated promotion, rollback, and a playground |
| Bundles | Context bundle versions, diffs, gated promotion, and rollback |
| Deployments | Traffic splits, canary results per revision, replicas, the queue, and tenant usage |
| Costs | Cost per day and model, against budgets |
| Health | Provider health, circuit states, metrics |
| Operations | The operation queue, with leases and errors |
| Audit | Every change and every refused attempt, for admins |

The studio binds `127.0.0.1`, requires the token on every request and a header on every change,
refuses non-loopback hosts, bounds every request body, and inserts every value as text. Its threat
review is in [SECURITY.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/SECURITY.md#the-studio-and-its-accounts).

Full guide: [docs/studio.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/studio.md).

Requires Node.js 22 and nexus-ai-pro 2.0 or newer. Stable from 2.5, with its graduation evidence in
[API_STABILITY.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/API_STABILITY.md).
