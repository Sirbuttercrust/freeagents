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
  {
    // THE DOM IS NOW IN SCOPE FOR EVERY FILE, AND SERVER CODE MUST NOT USE IT.
    //
    // tests/web/render.test.ts drives jsdom, so @types/jsdom is a dependency,
    // and its base.d.ts opens with `/// <reference lib="dom" />`. A lib
    // reference is program-wide: from the moment it landed, `document`,
    // `window` and `localStorage` type-check inside express route handlers,
    // where they are all undefined at runtime.
    //
    // The typecheck used to catch that and now cannot, so the guard moves
    // here. Scoped to server TypeScript: the browser scripts under
    // src/web/public/js are real DOM code and are configured separately at
    // the end of this file.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Server code has no DOM. This types as valid only because @types/jsdom pulls lib.dom in for the test suite.' },
        { name: 'window', message: 'Server code has no DOM. This types as valid only because @types/jsdom pulls lib.dom in for the test suite.' },
        { name: 'navigator', message: 'Server code has no DOM. This types as valid only because @types/jsdom pulls lib.dom in for the test suite.' },
        { name: 'localStorage', message: 'Server code has no DOM. This types as valid only because @types/jsdom pulls lib.dom in for the test suite.' },
        { name: 'sessionStorage', message: 'Server code has no DOM. This types as valid only because @types/jsdom pulls lib.dom in for the test suite.' },
        { name: 'alert', message: 'Server code has no DOM. This types as valid only because @types/jsdom pulls lib.dom in for the test suite.' },
      ],
    },
  },
  {
    // THE BROWSER SCRIPTS ARE LINTED, JUST NOT BY THE TYPE-AWARE PARSER.
    //
    // src/web/public/js/** is plain browser JavaScript served as static
    // files. tsconfig.json covers no .js, so the type-aware project service
    // cannot resolve these and every one failed the gate with "was not found
    // by the project service" the moment they landed.
    //
    // The cheap move is to add them to `ignores` beside spec/**. That is
    // wrong here and right there: spec/** is a wireframe artifact that never
    // ships, while THIS code runs in every visitor's browser. Ignoring it
    // would mean a typo in a shipped script is caught by nobody.
    //
    // So the project service is switched off for these files and the plain
    // recommended rules stay on, which is what catches the mistakes that
    // actually happen in this style of code: an undefined name, an unused
    // variable, a duplicate key, a fallthrough case.
    //
    // THIS BLOCK MUST STAY LAST. Flat config is last-wins per matched file,
    // and the block above sets projectService for everything: written before
    // it, this one is overridden and all thirteen scripts fail again with
    // the exact error it exists to fix. Measured, not assumed.
    files: ['src/web/public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      parserOptions: { projectService: false, project: false },
      // Declared explicitly rather than pulled from a `globals` package: it
      // is not a dependency here, and this list is short enough that adding
      // one to save a few lines would be the worse trade.
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        DOMParser: 'readonly',
        Promise: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        matchMedia: 'readonly',
        getComputedStyle: 'readonly',
        performance: 'readonly',
        console: 'readonly',
        SVGElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        // The landing page's own globals, each defined by one script in
        // src/web/public/js/landing and read by the others.
        FA: 'readonly',
        FACore: 'readonly',
        FAInsects: 'readonly',
        FAFamilies: 'writable',
        FAFamilyIds: 'writable',
        FASwarm: 'readonly',
        FAFlock: 'readonly',
        FAReveal: 'readonly',
        FASmoothScroll: 'readonly',
        FAApi: 'readonly',
      },
    },
    rules: {
      // The type-aware TypeScript rules do not apply to a plain script and
      // would only produce noise about types that are not written down.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // GUARD AGAINST A BARE DUAL-STACK .listen(0) IN TESTS.
  //
  // t_1a902961 fixed 69 call sites where a test server bound with a bare
  // `.listen(0)`. On this OS a dual-stack listen(0) can be handed a port
  // number a *different*, unrelated process already holds fixed to
  // 127.0.0.1, and the test's own `fetch('http://127.0.0.1:<port>/...')`
  // then silently reaches that foreign process instead of the test's own
  // server. Proof measured 5 mismatches / 4000 cycles bare vs 0 / 4000 with
  // the host pinned, confirmed via lsof that the collisions were real
  // foreign listeners. Nothing stopped a new test file from reintroducing
  // the bare form, so it is enforced here instead of re-discovered by hand.
  //
  // Three selectors instead of one, each catching a different way the
  // second argument can be wrong, so the failure message tells you exactly
  // what shape was found:
  //   1. no second argument at all -- `.listen(0)`.
  //   2. a second argument that exists but is not a plain string literal --
  //      most commonly the readiness callback landing in that slot, e.g.
  //      `.listen(0, () => { ... })` or `.listen(0, resolve)`.
  //   3. a second argument that IS a string literal but not '127.0.0.1' --
  //      e.g. 'localhost', which resolves differently across machines.
  //
  // tests/manual/seed-server.ts is exempted below: it is a manual dev
  // fixture, not a suite test, and deliberately binds a fixed `PORT` (so
  // a human can point a browser at a stable address) rather than an
  // ephemeral one -- the flake this rule guards against cannot occur on a
  // server nothing else on the box is contending for.
  {
    files: ['tests/**/*.ts'],
    ignores: ['tests/manual/seed-server.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // esquery has no `arguments.N` index syntax (see
          // estools/esquery#130) -- `.arguments` is a pseudo-class matched
          // against each direct child of the CallExpression, so the second
          // argument is selected with `.arguments:nth-child(2)`
          // (nth-child is 1-based). `[arguments.length<2]` is a genuine
          // attribute path though, since `.length` is a real property of
          // the arguments array, which is why selector 1 below can use it
          // directly while 2 and 3 need the nth-child idiom.
          selector: "CallExpression[callee.property.name='listen'][arguments.length<2]",
          message:
            "Bare .listen(port) dual-stack-binds and can collide with an unrelated 127.0.0.1 daemon holding the same port (see t_1a902961). Use .listen(port, '127.0.0.1').",
        },
        {
          selector:
            "CallExpression[callee.property.name='listen'] > .arguments:nth-child(2):not(Literal)",
          message:
            "The second argument to .listen() in tests must be the literal string '127.0.0.1' (see t_1a902961), not a callback or variable.",
        },
        {
          selector:
            "CallExpression[callee.property.name='listen'] > Literal.arguments:nth-child(2)[value!='127.0.0.1']",
          message:
            "The second argument to .listen() in tests must be exactly '127.0.0.1' (see t_1a902961) to force loopback-only binding.",
        },
      ],
    },
  },

  // BUILD SCRIPTS. Node modules under scripts/, run by npm rather than
  // imported by the app, so tsconfig does not cover them. They are still
  // linted rather than ignored: `npm run build` calls them, and a typo in a
  // build script breaks the deploy just as thoroughly as one in a route.
  //
  // Globals are declared inline here for the same reason they are for the
  // browser scripts: the `globals` package is not a dependency of this repo.
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
