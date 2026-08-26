import { createApp } from './app.js';
import { resolveListenPort } from '../adapters/runtime/runtime.js';

const port = resolveListenPort();

createApp().listen(port, () => {
  console.log(`freeagents listening on port ${port}`);
});
