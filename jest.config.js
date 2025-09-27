module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest"
  },
  moduleNameMapper: {
    "^vscode$": "<rootDir>/src/test/__mocks__/vscode.js"
  },
  setupFilesAfterEnv: ["<rootDir>/src/test/setupTests.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/test/**"]
};
