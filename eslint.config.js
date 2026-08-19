import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `mockups/**`, `.factory/**` and `.worktrees/**` are gitignored, but
    // eslint does not read .gitignore -- it walks the working tree. So a local
    // scratch file made the GATE COMMAND FAIL on this machine while passing in
    // a fresh clone, which is the worst shape a gate failure can take: it
    // depends on who is looking. The factory's Gate 1 runs this exact command,
    // so an untracked mockup would have blocked every build.
    //
    // `.worktrees/**` was added 2026-08-19 after it bit. Every factory build
    // runs inside `.worktrees/<slug>/`, so WHILE A BUILD IS IN FLIGHT the main
    // checkout contains a complete second copy of the project. Linting main
    // then lints the in-progress build and reports its half-finished code as
    // errors against main, so the gate goes red for work that is not even on
    // the branch being gated.
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/generated/**',
      'mockups/**',
      '.factory/**',
      '.worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
