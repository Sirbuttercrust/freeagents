import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `mockups/**` and `.factory/**` are gitignored, but eslint does not read
    // .gitignore -- it walks the working tree. So a local scratch file made the
    // GATE COMMAND FAIL on this machine while passing in a fresh clone, which
    // is the worst shape a gate failure can take: it depends on who is looking.
    // The factory's Gate 1 runs this exact command, so an untracked mockup
    // would have blocked every build.
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**', 'mockups/**', '.factory/**'],
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
