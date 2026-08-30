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
      // The wireframe is a SPEC artifact, not shipped source. It is a plain
      // browser script with no tsconfig covering it, so the type-aware lint
      // rules cannot resolve it and every run failed with
      //   allowDefaultProject ... does not match 'spec/wireframe/wireframe.js'
      // which blocked the gate for every factory lap. Added 2026-08-20 with
      // the wireframe merge.
      'spec/**',
      '.factory/**',
      '.worktrees/**',
      // builds/** holds per-SHA merge-staging copies of the whole tree
      // (gitignored, like the above). Same failure shape as .worktrees: a
      // copy of the project at an old SHA cannot satisfy THIS tree's
      // tsconfig project service, so its files report parsing errors against
      // main. Measured 2026-08-26: 626/626 lint errors came from
      // builds/{38b496d,2e6e157}/ while typecheck passed clean -- the gate
      // was reading archive boxes as source.
      'builds/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // BUILD SCRIPTS. Node modules under scripts/, run by npm rather than
  // imported by the app, so tsconfig does not cover them. Still linted
  // rather than ignored: `npm run build` calls them, and a typo in a build
  // script breaks the deploy just as thoroughly as one in a route.
  //
  // Globals declared inline for the same reason as elsewhere in this file:
  // the `globals` package is not a dependency of this repo.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
