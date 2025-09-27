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
        }
];