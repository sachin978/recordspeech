import { defineConfig } from "@playwright/test";

import { APP_PORT, DATA_DIR, FIXTURES, MOCK_PORT, TEST_KEY } from "./tests/e2e/env";

// End-to-end tests run the REAL app (production build) in real Chrome with a fake
// microphone fed from generated audio, against a local mock of the OpenAI API.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  grepInvert: process.env.LONG ? undefined : /@long/,
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    channel: "chrome",
    headless: true,
    permissions: ["microphone"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${FIXTURES}/speechlike.wav`, "--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: [
    {
      command: `python3 scripts/make-fixtures.py ${FIXTURES} && node tests/mock/openai-mock.mjs`,
      url: `http://127.0.0.1:${MOCK_PORT}/__log`,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_EXPECTED_KEY: TEST_KEY },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `rm -rf ${DATA_DIR} && npx next build && npx next start -H 127.0.0.1 -p ${APP_PORT}`,
      url: `http://127.0.0.1:${APP_PORT}/api/health`,
      env: {
        OPENAI_API_KEY: TEST_KEY,
        OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
        DATA_DIR,
        ANALYSIS_BATCH_SIZE: "2",
        OPENAI_MAX_CONCURRENCY: "3",
      },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
