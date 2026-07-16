import nx from '@nx/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  eslintConfigPrettier,
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/coverage',
      '**/.expo',
      'apps/fairway/ios',
      'apps/fairway/android',
      'reference/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // README §2 — the collision guard for parallel agents. An arrow in the
      // dependency graph = an entry here. Nx rejects anything else.
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          depConstraints: [
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['*'] },
            {
              sourceTag: 'lib:store',
              onlyDependOnLibsWithTags: [
                'lib:types',
                'lib:monitor',
                'lib:data',
                'lib:drill',
              ],
            },
            { sourceTag: 'lib:wrist', onlyDependOnLibsWithTags: ['lib:types'] },
            {
              sourceTag: 'lib:drill',
              onlyDependOnLibsWithTags: ['lib:types', 'lib:analytics'],
            },
            {
              sourceTag: 'lib:analysis',
              onlyDependOnLibsWithTags: ['lib:types', 'lib:analytics'],
            },
            { sourceTag: 'lib:analytics', onlyDependOnLibsWithTags: ['lib:types'] },
            { sourceTag: 'lib:data', onlyDependOnLibsWithTags: ['lib:types'] },
            { sourceTag: 'lib:viz', onlyDependOnLibsWithTags: ['lib:types'] },
            { sourceTag: 'lib:monitor', onlyDependOnLibsWithTags: ['lib:types'] },
            {
              sourceTag: 'lib:flight-model',
              onlyDependOnLibsWithTags: ['lib:types'],
            },
            { sourceTag: 'lib:ui', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'lib:types', onlyDependOnLibsWithTags: [] },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/jest.config.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // test fakes legitimately no-op the methods a test doesn't exercise
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
