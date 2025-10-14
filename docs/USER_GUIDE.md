# Code Ingest User Guide

## Table of Contents
- [Getting Started](#getting-started)
- [Basic Usage](#basic-usage)
- [Advanced Features](#advanced-features)
- [Remote Repositories](#remote-repositories)
- [Configuration](#configuration)
- [Output Formats](#output-formats)
- [Troubleshooting](#troubleshooting)

## Getting Started

### Installation
1. Open VS Code.
2. Go to Extensions (`Ctrl+Shift+X`).
3. Search for "Code Ingest".
4. Click **Install**.

### First Use
1. Open your project workspace.
2. Click the **Code Ingest** icon in the Activity Bar (left sidebar).
3. The Code Ingest panel opens showing your file tree.

### Webview Assets
- If you are developing or packaging the extension, run `npm run build:webview` (or `npm run build:webview && npm run build`) to ensure all dashboard assets are available before testing or distributing the extension.

## Basic Usage

### Selecting Files
- **Individual files**: Check or uncheck files in the tree view.
- **Select all**: Click the **Select All** button.
- **Pattern selection**: Use the filter box to select files by pattern.
- **By file type**: Right-click → **Select all .js files**.

### Generating a Digest
1. Select the files you want to include.
2. Choose the output format (Markdown, JSON, or Text).
3. Click **Generate Digest**.
4. Choose where to save or copy the result.

### Preview Mode
- View a live preview of your digest as you select files.
- Token count updates in real time.
- Preview content is truncated automatically for performance.

## Advanced Features

### Smart Filtering

```json
{
  "codeIngest.includePatterns": ["src/**/*.ts", "**/*.md"],
  "codeIngest.excludePatterns": ["**/*.test.ts", "node_modules/**"]
}
```

### Secret Redaction
The extension automatically detects and redacts:
- API keys and tokens
- Passwords and credentials
- Email addresses (optional)
- Custom patterns that you define

```json
{
  "codeIngest.redactionPatterns": [
    "api[_-]?key\\s*[:=]\\s*['\"]",
    "password\\s*[:=]\\s*['\"]"
  ]
}
```

### Jupyter Notebook Support
- Include or exclude code cells.
- Include or exclude markdown cells.
- Include or exclude cell outputs.
- Handle image and HTML outputs.

```json
{
  "codeIngest.notebookIncludeCodeCells": true,
  "codeIngest.notebookIncludeMarkdownCells": true,
  "codeIngest.notebookIncludeOutputs": false
}
```

## Remote Repositories

### Loading a Remote Repository
1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **Code Ingest: Load Remote Repository**.
3. Enter the repository URL.
4. Select branch or tag (optional).
5. Configure sparse checkout (optional).

### Supported Platforms
- GitHub (public and private)
- GitLab
- Bitbucket
- Any Git-compatible repository

### Authentication
- Uses your system Git credentials
- Supports SSH keys
- Supports personal access tokens
- Prompts for credentials when needed

### Performance Optimization
- **Partial Clone**: Only downloads necessary objects.
- **Sparse Checkout**: Only checks out specified paths.
- **Shallow Clone**: Limits history depth.

## Configuration

### File Selection

```json
{
  "codeIngest.maxFiles": 1000,
  "codeIngest.maxDepth": 10,
  "codeIngest.followSymlinks": false
}
```

### Output Control

```json
{
  "codeIngest.outputFormat": "markdown",
  "codeIngest.includeMetadata": true,
  "codeIngest.binaryFilePolicy": "skip"
}
```

### Performance Settings

```json
{
  "codeIngest.cache.enabled": true,
  "codeIngest.cache.maxMemoryMB": 100,
  "codeIngest.tokenizer": "auto"
}
```

## Output Formats

### Markdown Format
Best for documentation and sharing:

```
Project Digest
Summary
Files: 42

Languages: TypeScript, JavaScript, JSON

Estimated Tokens: 15,420

File Structure
...
```

### JSON Format
Best for programmatic processing:

```json
{
  "metadata": { ... },
  "summary": { ... },
  "files": [ ... ]
}
```

### Text Format
Best for plain text environments:

```
PROJECT DIGEST
Files: 42
Languages: TypeScript, JavaScript, JSON
...
```

## Troubleshooting

### Common Issues

#### "No files selected"
- Check your include or exclude patterns.
- Verify files are not filtered by `.gitignore`.
- Use **Select All** to see if any files are available.

#### "Git not found"
- Install Git and add it to your PATH.
- Restart VS Code after installing Git.
- Run `git --version` in your terminal to confirm.

#### "Authentication failed"
- Set up SSH keys or personal access tokens.
- Check repository URL and permissions.
- Try cloning the repository manually first.

#### Performance Issues
- Reduce the `maxFiles` setting.
- Enable caching.
- Use sparse checkout for remote repositories.
- Close other applications to free memory.

### Diagnostic Commands
- **System Check**: `Code Ingest: Run Diagnostics`
- **Performance Analysis**: `Code Ingest: Analyze Performance`
- **View Logs**: Open Output panel → Code Ingest

### Getting Help
- [GitHub Issues](https://github.com/your-org/code-ingest/issues)
- [Documentation](https://code-ingest.com/docs)
- [Community Discussions](https://github.com/your-org/code-ingest/discussions)
