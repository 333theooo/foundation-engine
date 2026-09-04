import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

/**
 * ESLint configuration.
 *
 * `eslint-config-next` ships flat configs directly, so no `FlatCompat` shim is
 * needed. The two custom rule groups exist to enforce things this codebase
 * depends on: no dynamic code execution anywhere (the AI boundary rests on it),
 * and no untyped `any` outside tests.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
      'storage/**',
      'src/generated/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'eval', message: 'Dynamic code execution is forbidden in this codebase.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'Dynamic code execution is forbidden in this codebase.',
        },
      ],
    },
  },
  {
    // React Three Fiber uses lowercase intrinsic elements ESLint cannot know about.
    files: ['src/three/**/*.tsx', 'src/components/studio/**/*.tsx'],
    rules: { 'react/no-unknown-property': 'off' },
  },
  {
    /**
     * The React Compiler's immutability rules model a pure-render world. The
     * Three.js integration is deliberately imperative: `camera`, `gl` and the
     * OrbitControls instance all come from `useThree()` and are *meant* to be
     * mutated — that is how react-three-fiber works, and there is no declarative
     * alternative for moving a camera or setting a clipping plane.
     *
     * Scoped to `src/three` only. Everywhere else the rules stay on, and the
     * violations they found in the UI layer were real bugs that have been fixed.
     */
    files: ['src/three/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/immutability': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];

export default config;
