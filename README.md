# Code Ingest – VS Code Extension

A professional-grade VS Code extension for generating comprehensive codebase digests with advanced filtering, remote repository support, and intelligent content processing.

## ✨ Features

### 🎯 Core Functionality

- **Smart File Scanning**: Hierarchical scanning with `.gitignore` support and intelligent filtering
- **Multiple Output Formats**: Generate digests in Markdown, JSON, or plain text formats
- **Remote Repository Ingestion**: Clone and process remote repositories with partial clone optimization
- **Jupyter Notebook Support**: Comprehensive notebook processing with configurable cell inclusion
- **Secret Redaction**: Automatic detection and redaction of sensitive information
- **Performance Optimized**: Efficient processing of large codebases with progress tracking

### 🔧 Advanced Features

- **Interactive Sidebar**: Persistent dashboard with real-time file tree and preview
- **Selective Processing**: Checkbox-based file selection with pattern matching
- **Token Analysis**: Accurate token counting with multiple tokenizer support
- **Caching System**: Intelligent caching for improved performance
- **Error Recovery**: Robust error handling with detailed diagnostics
- **Telemetry & Diagnostics**: Privacy-compliant analytics and system health monitoring

## 🚀 Quick Start

### Installation

- Install from VS Code Marketplace: [`code-ingest`](https://marketplace.visualstudio.com/items?itemName=your-publisher.code-ingest)
- Or install from VSIX: Download the latest release from the [Releases](https://github.com/your-org/code-ingest/releases) page

### Basic Usage

1. Open your project in VS Code.
2. Click the **Code Ingest** icon in the Activity Bar.
3. Select files using the interactive tree.
4. Click **Generate Digest** to create your codebase summary.

### Remote Repository Processing

1. Open the Command Palette and run **Code Ingest: Load Remote Repository**.
2. Enter the repository URL (supports GitHub, GitLab, Bitbucket, and any Git-compatible host).
3. Select branch/tag and configure sparse checkout options.
4. Generate a digest from the loaded repository.

## 📖 Documentation

- [User Guide](docs/USER_GUIDE.md) – Complete usage instructions
- [Configuration Reference](docs/CONFIGURATION.md) – All settings explained
- [API Documentation](docs/API.md) – Programmatic usage
- [Troubleshooting Guide](docs/TROUBLESHOOTING.md) – Common issues and solutions
- [Developer Guide](docs/DEVELOPER_GUIDE.md) – Contributing and development setup

## ⚙️ Configuration

### Key Settings

```json
{
	"codeIngest.maxFiles": 1000,
	"codeIngest.outputFormat": "markdown",
	"codeIngest.binaryFilePolicy": "skip",
	"codeIngest.redactionPatterns": ["api[_-]?key", "password"],
	"codeIngest.notebookIncludeOutputs": true
}
```

### Remote Repository Settings

```json
{
	"codeIngest.remoteRepo.usePartialClone": true,
	"codeIngest.remoteRepo.maxTimeout": 300000,
	"codeIngest.remoteRepo.keepTempDirs": false
}
```

## 🎨 Output Formats

### Markdown Format

```
# Codebase Digest

## Summary
- Files processed: 150
- Total tokens: ~25,000
- Languages: TypeScript (75%), JavaScript (20%), JSON (5%)

## File Structure
src/
├── services/
│   ├── fileScanner.ts
│   └── digestGenerator.ts
└── utils/
		└── formatters.ts
```

### JSON Format

```json
{
	"metadata": {
		"generatedAt": "2025-10-10T20:00:00.000Z",
		"totalFiles": 150,
		"tokenEstimate": 25000
	},
	"files": [
		{
			"path": "src/services/fileScanner.ts",
			"language": "typescript",
			"content": "// File content..."
		}
	]
}
```

## 🔐 Privacy & Security

- **No Data Collection**: Your code never leaves your machine unless explicitly exported.
- **Secret Redaction**: Automatic detection and redaction of API keys, tokens, and passwords.
- **Configurable Privacy**: Full control over what data is included in outputs.
- **Telemetry**: Optional, anonymous usage analytics (opt-in only).

## 📊 Performance

- **Large Repositories**: Efficiently handles repositories with 10,000+ files.
- **Memory Efficient**: Streaming processing for large files.
- **Parallel Processing**: Multi-threaded file scanning and processing.
- **Caching**: Intelligent caching reduces repeated work.

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
git clone https://github.com/your-org/code-ingest
cd code-ingest
npm install
npm run build
code .
```

### Running Tests

```bash
npm run test:unit       # Unit tests
npm run test:integration # Integration tests
npm run test:e2e         # End-to-end tests
```

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for a complete history of changes.

## 📄 License

This project is licensed under the MIT License – see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with the VS Code Extension API
- Uses Chart.js for performance dashboards
- Powered by Zustand for state management
- Thanks to all contributors and users

## 📞 Support

- [Documentation](docs/)
- [Issues](https://github.com/your-org/code-ingest/issues)
- [Discussions](https://github.com/your-org/code-ingest/discussions)
- [Email Support](mailto:support@code-ingest.com)

---

Made with ❤️ by the Code Ingest team
