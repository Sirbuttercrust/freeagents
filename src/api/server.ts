import { createApp } from './app.js';
import { resolveListenPort } from '../adapters/runtime/runtime.js';
import { buildConfigReport, formatConfigReport } from '../adapters/config/report.js';

const port = resolveListenPort();

// P9: printed once, at startup, additive to every rail's own call-time
// fail-closed guard. This never throws and never exits the process; an
// operator who wants to run without USDC configured is told plainly that
// the USDC rail is off, not stopped from running.
console.log(formatConfigReport(buildConfigReport()));

createApp().listen(port, () => {
  console.log(`freeagents listening on port ${port}`);
});
