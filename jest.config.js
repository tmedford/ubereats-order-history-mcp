/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup/quiet-console.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { ...require("./tsconfig.json").compilerOptions, rootDir: "." } }],
  },
};
