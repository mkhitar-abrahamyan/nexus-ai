/** Starts the studio on the demo application: `npm run studio:demo`. */
import { startStudio } from '../src/server.js';
import { createDemoSources } from './demo.js';

const { threadId: _thread, experimentIds: _experiments, ...sources } = await createDemoSources();
const running = await startStudio(sources, { port: Number(process.env.PORT ?? 4747) });
console.log(`Nexus studio demo is running. Open:\n\n  ${running.url}\n\nPress Ctrl+C to stop.`);
