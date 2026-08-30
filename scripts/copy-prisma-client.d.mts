// Ambient declarations for copy-prisma-client.mjs, a plain Node script
// deliberately not compiled by tsc (see the header comment in the .mjs
// file: matches scripts/copy-web-assets.mjs's precedent of staying a
// dependency-free script any contributor's `node` can run directly).
// tests/build/copy-prisma-client.test.ts imports its exports to test the
// copy logic against a scratch directory, and NodeNext module resolution
// looks for a sibling .d.mts when importing a .mjs file with no allowJs.

export declare class PrismaClientNotFoundError extends Error {}

export declare function copyPrismaClient(root: string): string;
