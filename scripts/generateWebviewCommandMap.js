#!/usr/bin/env node
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const { promises: fsp } = fs;

class WebviewCommandMapGenerator {
  constructor(options = {}) {
    this.srcDir = options.srcDir || path.join(__dirname, '..', 'src');
    this.webviewDir = options.webviewDir || path.join(__dirname, '..', 'resources', 'webview');
    this.outputFile = options.outputFile || path.join(this.webviewDir, 'commandMap.generated.js');
    this.packageJsonPath = options.packageJsonPath || path.join(__dirname, '..', 'package.json');

    this.commands = {
      hostToWebview: new Map(),
      webviewToHost: new Map(),
    };
  }

  async generate() {
    console.log('🔄 Generating webview command map...');

    try {
      await this.extractPackageJsonCommands();
      await this.scanSourceFiles();
      await this.scanWebviewFiles();
      await this.generateCommandMapFile();
      await this.generateTypeDefinitions();
      console.log('✅ Command map generated successfully');
      await this.validateCommandSync();
      this.printSummary();
    } catch (error) {
      console.error('❌ Failed to generate command map:', error);
      process.exit(1);
    }
  }

  async extractPackageJsonCommands() {
    const buffer = await fsp.readFile(this.packageJsonPath, 'utf8');
    const packageJson = JSON.parse(buffer);
    const contributes = packageJson.contributes || {};
    const commands = Array.isArray(contributes.commands) ? contributes.commands : [];
    let registeredCount = 0;

    for (const command of commands) {
      if (command && typeof command.command === 'string' && command.command.startsWith('codeIngest.')) {
        this.upsertCommand(this.commands.webviewToHost, command.command, {
          id: command.command,
          title: command.title,
          category: command.category || 'CodeIngest',
          when: command.when,
          icon: command.icon,
          source: 'package.json',
        });
        registeredCount += 1;
      }
    }

    console.log(`📦 Found ${registeredCount} commands in package.json`);
  }

  async scanSourceFiles() {
    const sourceFiles = await this.findFiles(this.srcDir, /\.(ts|mts|cts|js|mjs|cjs)$/i);

    for (const filePath of sourceFiles) {
      await this.scanFileForCommands(filePath);
    }

    console.log(`🔍 Scanned ${sourceFiles.length} source files`);
  }

  async scanFileForCommands(filePath) {
    const content = await fsp.readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    this.findCommandRegistrations(sourceFile, filePath);
    this.findWebviewMessages(sourceFile, filePath);
  }

  findCommandRegistrations(sourceFile, filePath) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && this.isCommandRegistration(node) && node.arguments.length > 0) {
        const commandId = this.extractStringLiteral(node.arguments[0]);
        const normalized = typeof commandId === 'string' ? commandId.trim() : '';
        if (normalized && normalized.startsWith('codeIngest.')) {
          const location = this.getLocation(sourceFile, node, filePath);
          this.upsertCommand(this.commands.webviewToHost, normalized, {
            id: normalized,
            file: location.file,
            line: location.line,
            source: 'registration',
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  findWebviewMessages(sourceFile, filePath) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && this.isWebviewPostMessage(node) && node.arguments.length > 0) {
        const messageData = this.extractMessageData(node.arguments[0]);
        if (messageData && typeof messageData.command === 'string') {
          const normalized = messageData.command.trim();
          if (normalized) {
            const location = this.getLocation(sourceFile, node, filePath);
            this.upsertCommand(this.commands.hostToWebview, normalized, {
              id: normalized,
              type: messageData.type,
              file: location.file,
              line: location.line,
              source: 'postMessage',
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  isCommandRegistration(node) {
    if (!node.expression || !ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }

    if (node.expression.name.text !== 'registerCommand') {
      return false;
    }

    const qualifier = node.expression.expression;
    if (ts.isPropertyAccessExpression(qualifier)) {
      return qualifier.name.text === 'commands';
    }

    return false;
  }

  isWebviewPostMessage(node) {
    if (!node.expression || !ts.isPropertyAccessExpression(node.expression)) {
      return false;
    }

    if (node.expression.name.text !== 'postMessage') {
      return false;
    }

    const qualifier = node.expression.expression;
    return ts.isPropertyAccessExpression(qualifier) && qualifier.name.text === 'webview';
  }

  extractStringLiteral(node) {
    if (!node) {
      return null;
    }

    if (ts.isStringLiteral(node)) {
      return node.text;
    }

    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }

    return null;
  }

  extractMessageData(argument) {
    if (!argument || !ts.isObjectLiteralExpression(argument)) {
      return null;
    }

    const result = {};

    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }

      const key = this.getPropertyName(property.name);
      if (!key) {
        continue;
      }

      const literalValue = this.extractStringLiteral(property.initializer);
      if (literalValue !== null) {
        result[key] = literalValue;
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  getPropertyName(nameNode) {
    if (ts.isIdentifier(nameNode)) {
      return nameNode.text;
    }

    if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) {
      return nameNode.text;
    }

    return null;
  }

  async scanWebviewFiles() {
    const pattern = /\.(mjs|cjs|js|ts|jsx|tsx|html)$/i;
    const webviewFiles = await this.findFiles(this.webviewDir, pattern);

    for (const filePath of webviewFiles) {
      if (filePath.endsWith('.generated.js')) {
        continue;
      }
      await this.scanWebviewFileForCommands(filePath);
    }

    console.log(`🌐 Scanned ${webviewFiles.length} webview files`);
  }

  async scanWebviewFileForCommands(filePath) {
    const content = await fsp.readFile(filePath, 'utf8');

    const postMessagePattern = /postMessage\s*\(\s*{[^}]*command\s*:\s*['"`]([^'"`]+)['"`]/g;
    let match;

    while ((match = postMessagePattern.exec(content)) !== null) {
      const commandId = match[1];
      const normalized = typeof commandId === 'string' ? commandId.trim() : '';
      if (normalized && normalized.startsWith('codeIngest.')) {
        this.upsertCommand(this.commands.webviewToHost, normalized, {
          id: normalized,
          file: path.relative(this.webviewDir, filePath),
          source: 'webview-usage',
        });
      }
    }

    const messageHandlerPattern = /case\s+['"`]([^'"`]+)['"`]\s*:/g;
    while ((match = messageHandlerPattern.exec(content)) !== null) {
      const messageType = match[1];
      const normalized = typeof messageType === 'string' ? messageType.trim() : '';
      if (normalized) {
        this.upsertCommand(this.commands.hostToWebview, normalized, {
          id: normalized,
          file: path.relative(this.webviewDir, filePath),
          source: 'webview-handler',
        });
      }
    }
  }

  async generateCommandMapFile() {
    const hostToWebviewKeys = [...this.commands.hostToWebview.keys()].sort();
    const webviewToHostKeys = [...this.commands.webviewToHost.keys()].sort();

    const hostToWebview = hostToWebviewKeys.reduce((accumulator, key) => {
      const baseKey = this.derivePropertyKey(key, 'hostCommand');
      const prop = this.ensureUniqueKey(accumulator, baseKey);
      accumulator[prop] = key;
      return accumulator;
    }, {});

    const webviewToHost = webviewToHostKeys.reduce((accumulator, key) => {
      const trimmed = key.startsWith('codeIngest.') ? key.substring('codeIngest.'.length) : key;
      const baseKey = this.derivePropertyKey(trimmed, 'webviewCommand');
      const prop = this.ensureUniqueKey(accumulator, baseKey);
      accumulator[prop] = key;
      return accumulator;
    }, {});

    this.generatedHostMap = hostToWebview;
    this.generatedWebviewMap = webviewToHost;

    const fileContent = `// This file is auto-generated by scripts/generateWebviewCommandMap.js\n\n// Do not edit manually - changes will be overwritten\n\n/**\n * Command map for CodeIngest webview communication\n * Generated on: ${new Date().toISOString()}\n */\n\nexport const COMMAND_MAP = {\n  // Commands sent from extension host to webview\n  HOST_TO_WEBVIEW: ${JSON.stringify(hostToWebview, null, 2)},\n\n  // Commands sent from webview to extension host\n  WEBVIEW_TO_HOST: ${JSON.stringify(webviewToHost, null, 2)}\n};\n\n// Reverse lookup maps for validation\nexport const HOST_TO_WEBVIEW_REVERSE = Object.fromEntries(\n  Object.entries(COMMAND_MAP.HOST_TO_WEBVIEW).map(([key, value]) => [value, key])\n);\n\nexport const WEBVIEW_TO_HOST_REVERSE = Object.fromEntries(\n  Object.entries(COMMAND_MAP.WEBVIEW_TO_HOST).map(([key, value]) => [value, key])\n);\n\n// Command validation functions\nexport function isValidHostToWebviewCommand(command) {\n  return Object.values(COMMAND_MAP.HOST_TO_WEBVIEW).includes(command);\n}\n\nexport function isValidWebviewToHostCommand(command) {\n  return Object.values(COMMAND_MAP.WEBVIEW_TO_HOST).includes(command);\n}\n\n// Get all available commands\nexport function getAllCommands() {\n  return {\n    hostToWebview: Object.values(COMMAND_MAP.HOST_TO_WEBVIEW),\n    webviewToHost: Object.values(COMMAND_MAP.WEBVIEW_TO_HOST)\n  };\n}\n`;

    await fsp.mkdir(path.dirname(this.outputFile), { recursive: true });
    await fsp.writeFile(this.outputFile, fileContent, 'utf8');
    console.log(`📝 Generated command map: ${this.outputFile}`);
  }

  async generateTypeDefinitions() {
    const hostEntries = Object.entries(this.generatedHostMap || {});
    const webviewEntries = Object.entries(this.generatedWebviewMap || {});

    const hostBody = hostEntries
      .map(([prop, command]) => `    ${prop}: '${command}';`)
      .join('\n');
    const webviewBody = webviewEntries
      .map(([prop, command]) => `    ${prop}: '${command}';`)
      .join('\n');

    const typeDefinitions = `// Auto-generated TypeScript definitions for webview commands\n// Generated on: ${new Date().toISOString()}\n\nexport interface CommandMap {\n  HOST_TO_WEBVIEW: {\n${hostBody ? `${hostBody}\n` : ''}  };\n\n  WEBVIEW_TO_HOST: {\n${webviewBody ? `${webviewBody}\n` : ''}  };\n}\n\nexport type HostToWebviewCommand = CommandMap['HOST_TO_WEBVIEW'][keyof CommandMap['HOST_TO_WEBVIEW']];\nexport type WebviewToHostCommand = CommandMap['WEBVIEW_TO_HOST'][keyof CommandMap['WEBVIEW_TO_HOST']];\n\nexport interface MessageEnvelope<T = unknown> {\n  id: string;\n  type: 'command' | 'response' | 'event';\n  command: string;\n  payload: T;\n  timestamp: number;\n  token: string;\n}\n`;

    const definitionPath = this.outputFile.replace(/\.js$/, '.d.ts');
    await fsp.writeFile(definitionPath, typeDefinitions, 'utf8');
    console.log(`📝 Generated type definitions: ${definitionPath}`);
  }

  async findFiles(dir, pattern) {
    const results = [];

    const traverse = async (currentDir) => {
      const entries = await fsp.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (entry.isFile() && pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    };

    await traverse(dir);
    return results;
  }

  upsertCommand(map, id, info) {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!normalizedId) {
      return;
    }

    const existing = map.get(normalizedId);
    if (!existing) {
      map.set(normalizedId, {
        id: normalizedId,
        sources: new Set(info.source ? [info.source] : []),
        locations: info.file ? [this.describeLocation(info.file, info.line)] : [],
        data: info ? [info] : [],
      });
      return;
    }

    if (info.source) {
      existing.sources.add(info.source);
    }

    if (info.file) {
      existing.locations.push(this.describeLocation(info.file, info.line));
    }

    existing.data.push(info);
  }

  describeLocation(file, line) {
    if (typeof line === 'number') {
      return `${file}:${line}`;
    }
    return file;
  }

  getLocation(sourceFile, node, filePath) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    return {
      file: path.relative(this.srcDir, filePath),
      line: line + 1,
    };
  }

  toCamelCase(value) {
    if (!value) {
      return '';
    }

    const withoutPrefix = value.replace(/^codeIngest\./, '');
    const rawSegments = withoutPrefix
      .split(/[^A-Za-z0-9]+/)
      .flatMap((segment) => segment.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .filter(Boolean);

    if (rawSegments.length === 0) {
      return '';
    }

    return rawSegments
      .map((segment, index) => {
        if (index === 0) {
          return segment.charAt(0).toLowerCase() + segment.slice(1);
        }
        return segment.charAt(0).toUpperCase() + segment.slice(1);
      })
      .join('');
  }

  derivePropertyKey(identifier, fallbackPrefix) {
    const camel = this.toCamelCase(identifier);
    if (camel && !/^[0-9]/.test(camel)) {
      return camel;
    }

    const fallback = identifier
      ? identifier
          .replace(/^codeIngest\./, '')
          .replace(/[^A-Za-z0-9]+/g, ' ')
          .trim()
          .split(/\s+/)
          .map((segment, index) => {
            if (index === 0) {
              return segment.toLowerCase();
            }
            return segment.charAt(0).toUpperCase() + segment.slice(1);
          })
          .join('')
      : '';

    const base = fallback || fallbackPrefix || 'command';
    if (/^[0-9]/.test(base)) {
      return `${fallbackPrefix || 'command'}${base}`;
    }
    return base;
  }

  ensureUniqueKey(target, desiredKey) {
    if (!Object.prototype.hasOwnProperty.call(target, desiredKey)) {
      return desiredKey;
    }

    let index = 2;
    let candidate = `${desiredKey}${index}`;
    while (Object.prototype.hasOwnProperty.call(target, candidate)) {
      index += 1;
      candidate = `${desiredKey}${index}`;
    }
    return candidate;
  }

  printSummary() {
    console.log('\n📊 Command Map Summary:');
    console.log(`  Host → Webview: ${this.commands.hostToWebview.size} commands`);
    console.log(`  Webview → Host: ${this.commands.webviewToHost.size} commands`);

    if (this.commands.hostToWebview.size > 0) {
      console.log('\n  Host → Webview Commands:');
      for (const [commandId, info] of this.commands.hostToWebview.entries()) {
        console.log(`    ${commandId} (${Array.from(info.sources).join(', ') || 'unknown'})`);
      }
    }

    if (this.commands.webviewToHost.size > 0) {
      console.log('\n  Webview → Host Commands:');
      for (const [commandId, info] of this.commands.webviewToHost.entries()) {
        console.log(`    ${commandId} (${Array.from(info.sources).join(', ') || 'unknown'})`);
      }
    }
  }

  async validateCommandSync() {
    const issues = [];

    for (const [commandId, info] of this.commands.webviewToHost.entries()) {
      if (info.sources.has('webview-usage') && !this.hasCommandRegistration(info.sources)) {
        issues.push(`❌ Command '${commandId}' used in webview but not registered`);
      }
    }

    for (const [commandId, info] of this.commands.webviewToHost.entries()) {
      if ((info.sources.has('registration') || info.sources.has('package.json')) && !info.sources.has('webview-usage')) {
        issues.push(`⚠️  Command '${commandId}' registered but not used in webview`);
      }
    }

    for (const [commandId, info] of this.commands.hostToWebview.entries()) {
      if (!info.sources.has('webview-handler')) {
        issues.push(`⚠️  Command '${commandId}' sent from host but no handler detected in webview`);
      }
    }

    if (issues.length > 0) {
      console.log('\n🔍 Validation Issues:');
      for (const issue of issues) {
        console.log(`  ${issue}`);
      }
    } else {
      console.log('\n✅ All commands appear synchronized');
    }

    return issues;
  }

  hasCommandRegistration(sourceSet) {
    return sourceSet.has('registration') || sourceSet.has('package.json');
  }
}

if (require.main === module) {
  const generator = new WebviewCommandMapGenerator();
  generator.generate().catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
}

module.exports = { WebviewCommandMapGenerator };
