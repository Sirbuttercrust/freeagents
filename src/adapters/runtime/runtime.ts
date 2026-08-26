// The only file in the tree allowed to know the string `BLOCKLET_`. If this
// adapter and blocklet.yml were both deleted, src/api/server.ts must still
// boot from PORT or the 3000 default, unchanged.

function parsePort(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`invalid port in ${name}: ${JSON.stringify(raw)}`);
  }
  return value;
}

export function resolveListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const blockletPort = env['BLOCKLET_PORT'];
  if (blockletPort) return parsePort('BLOCKLET_PORT', blockletPort);

  const port = env['PORT'];
  if (port) return parsePort('PORT', port);

  return 3000;
}
