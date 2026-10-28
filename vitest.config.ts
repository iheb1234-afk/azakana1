import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/azakana_test',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      META_APP_SECRET: 'test-secret',
      TELEGRAM_BOT_TOKEN: '',
    },
  },
});
