import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/web/**', '../../web/*', '../../../web/*'],
          message:
            'DICHROIC berlisensi GPL-3.0 dan EMULSION tidak. Impor menyeberang ' +
            'antara spektra/ dan web/ dilarang ke arah mana pun.',
        }],
      }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
