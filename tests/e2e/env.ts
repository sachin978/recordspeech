import path from "node:path";

export const APP_PORT = 3211;
export const MOCK_PORT = 3299;
export const TEST_KEY = "sk-test-e2e-SECRET-0123456789";
export const DATA_DIR = path.resolve(".tmp/e2e-data");
export const FIXTURES = path.resolve(".tmp/fixtures");
export const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
