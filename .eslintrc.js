module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
    'prettier'
  ],
  env: {
    node: true,
    es6: true
  },
  rules: {
    // Add custom rules here
  },
  overrides: [],
  ignorePatterns: ['node_modules/', 'dist/']
};
