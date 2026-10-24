/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'deps',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
};
