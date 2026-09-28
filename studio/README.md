# nexus-ai-pro-studio

A local studio for [nexus-ai-pro](https://www.npmjs.com/package/nexus-ai-pro): traces, threads,
approvals, experiments, prompts, costs, provider health, and the operation queue, served from your
own machine. It reads your application's own stores through the adapters it already uses, needs no
hosted service, and protects access with a token.

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
| Inbox | Threads waiting for a human, and review items waiting for a grade |
| Experiments | Compare two experiments with intervals and a verdict |
| Prompts | Versions, diffs, gated promotion, rollback, and a playground |
| Costs | Cost per day and model, against budgets |
| Health | Provider health, circuit states, metrics |
| Operations | The operation queue, with leases and errors |

The studio binds `127.0.0.1`, requires the token on every request and a header on every change,
refuses non-loopback hosts, and inserts every value as text.

Full guide: [docs/studio.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/studio.md).

Requires Node.js 22 and nexus-ai-pro 1.21 or newer. Experimental.
