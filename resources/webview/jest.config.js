/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  rootDir: __dirname,
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/test/setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1"
  },
  collectCoverageFrom: [
    "**/*.js",
    "!test/**",
    "!jest.config.js",
    "!commandMap.generated.js"
  ],
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        configFile: path.resolve(__dirname, "../../babel.config.cjs"),
        rootMode: "upward"
      }
    ]
  },
  transformIgnorePatterns: [],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  testMatch: ["<rootDir>/test/**/*.test.js"]
};
