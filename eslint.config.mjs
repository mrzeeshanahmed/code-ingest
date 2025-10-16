import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const tsRecommended = typescriptEslint.configs.recommended;

export default [
        {
            files: ["**/*.ts", "**/*.tsx"],
            languageOptions: {
                parser: tsParser,
                parserOptions: {
                    ecmaVersion: 2020,
                    sourceType: "module"
                }
            },
            plugins: {
                "@typescript-eslint": typescriptEslint
            },
            rules: {
                ...tsRecommended.rules
            }
        },
        {
            files: ["src/**/*.ts"],
            rules: {
                "no-restricted-properties": [
                    "error",
                    {
                        object: "process",
                        property: "exit",
                        message: "Prefer throwing or setting process.exitCode instead of process.exit in the extension runtime."
                    },
                    {
                        object: "process",
                        property: "kill",
                        message: "Route child process termination through GitProcessManager.safeKill instead of process.kill."
                    }
                ]
            }
        },
        {
            files: ["src/utils/gitProcessManager.ts"],
            rules: {
                "no-restricted-properties": [
                    "error",
                    {
                        object: "process",
                        property: "exit",
                        message: "Prefer throwing or setting process.exitCode instead of process.exit in the extension runtime."
                    }
                ]
            }
        }
];