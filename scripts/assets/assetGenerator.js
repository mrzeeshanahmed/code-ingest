'use strict';

const fs = require('fs').promises;
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const sharp = require('sharp');

class MarketplaceAssetGenerator {
  constructor() {
    this.assetsDir = path.join(__dirname, '..', '..', 'assets');
    this.outputDir = path.join(__dirname, '..', '..', 'marketplace-assets');

    this.brandColors = {
      primary: '#007ACC',
      secondary: '#1E1E1E',
      accent: '#00D2B8',
      text: '#CCCCCC',
      success: '#89D185',
      warning: '#F0C674'
    };

    this.iconSizes = {
      extension: { width: 128, height: 128 },
      marketplace: { width: 256, height: 256 },
      activity_bar: { width: 24, height: 24 },
      command_palette: { width: 16, height: 16 }
    };
  }

  async generateAllAssets() {
    console.log('🎨 Generating marketplace assets...');

    await this.ensureDirectories();
    await this.generateExtensionIcons();
    await this.generateScreenshots();
    await this.generatePromotionalGraphics();
    await this.generateMarketingMaterials();
    await this.optimizeAssets();
    await this.generateAssetManifest();

    console.log('✅ All marketplace assets generated successfully!');
  }

  async ensureDirectories() {
    const directories = [
      this.outputDir,
      path.join(this.outputDir, 'icons'),
      path.join(this.outputDir, 'screenshots'),
      path.join(this.outputDir, 'promotional'),
      path.join(this.outputDir, 'marketing')
    ];

    await Promise.all(
      directories.map((dirPath) => fs.mkdir(dirPath, { recursive: true }))
    );
  }

  async generateExtensionIcons() {
    console.log('📱 Generating extension icons...');

    const iconDesigns = [
      {
        name: 'main-icon',
        design: this.createMainIcon.bind(this),
        sizes: ['extension', 'marketplace']
      },
      {
        name: 'activity-bar-icon',
        design: this.createActivityBarIcon.bind(this),
        sizes: ['activity_bar']
      },
      {
        name: 'command-icon',
        design: this.createCommandIcon.bind(this),
        sizes: ['command_palette']
      }
    ];

    for (const iconConfig of iconDesigns) {
      for (const sizeKey of iconConfig.sizes) {
        const size = this.iconSizes[sizeKey];
        const canvas = createCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d');

        await iconConfig.design(ctx, size, 'dark');
        await this.saveCanvas(canvas, `icons/${iconConfig.name}-${sizeKey}-dark.png`);

        ctx.clearRect(0, 0, size.width, size.height);
        await iconConfig.design(ctx, size, 'light');
        await this.saveCanvas(canvas, `icons/${iconConfig.name}-${sizeKey}-light.png`);
      }
    }
  }

  createMainIcon(ctx, size, theme) {
    const { width, height } = size;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.35;

    const colors = theme === 'dark'
      ? {
          primary: this.brandColors.primary,
          secondary: this.brandColors.accent,
          background: 'transparent',
          text: this.brandColors.text
        }
      : {
          primary: '#0066CC',
          secondary: '#00A693',
          background: 'transparent',
          text: '#333333'
        };

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = colors.primary;
    ctx.fillStyle = colors.primary;
    ctx.lineWidth = width * 0.05;

    const boxSize = radius * 1.5;
    const boxX = centerX - boxSize / 2;
    const boxY = centerY - boxSize / 2;

    ctx.strokeRect(boxX, boxY, boxSize, boxSize);

    this.drawIngestionArrow(
      ctx,
      centerX + boxSize / 2 + width * 0.1,
      centerY,
      boxSize * 0.3,
      colors.secondary
    );

    this.drawCodeSymbols(ctx, boxX, boxY, boxSize, colors.primary);
    ctx.restore();
  }

  createActivityBarIcon(ctx, size, theme) {
    const { width, height } = size;
    ctx.save();
    ctx.clearRect(0, 0, width, height);

    const background = theme === 'dark' ? this.brandColors.secondary : '#F5F5F5';
    const primary = theme === 'dark' ? this.brandColors.primary : '#005FB8';
    const accent = theme === 'dark' ? this.brandColors.accent : '#008F7A';

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.roundRect(width * 0.15, height * 0.15, width * 0.7, height * 0.7, 3);
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width * 0.3, height * 0.35);
    ctx.lineTo(width * 0.7, height * 0.35);
    ctx.moveTo(width * 0.3, height * 0.5);
    ctx.lineTo(width * 0.7, height * 0.5);
    ctx.moveTo(width * 0.3, height * 0.65);
    ctx.lineTo(width * 0.6, height * 0.65);
    ctx.stroke();

    ctx.restore();
  }

  createCommandIcon(ctx, size, theme) {
    const { width, height } = size;
    ctx.save();
    ctx.clearRect(0, 0, width, height);

    const base = theme === 'dark' ? '#161616' : '#FFFFFF';
    const primary = theme === 'dark' ? this.brandColors.primary : '#005FB8';

    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = primary;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width * 0.3, height * 0.25);
    ctx.lineTo(width * 0.7, height * 0.5);
    ctx.lineTo(width * 0.3, height * 0.75);
    ctx.stroke();

    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.arc(width * 0.25, height * 0.5, width * 0.08, 0, Math.PI * 2);
    ctx.arc(width * 0.75, height * 0.5, width * 0.08, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawIngestionArrow(ctx, x, y, size, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;

    ctx.fillRect(x, y - size * 0.1, size * 0.6, size * 0.2);

    ctx.beginPath();
    ctx.moveTo(x + size * 0.5, y - size * 0.25);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x + size * 0.5, y + size * 0.25);
    ctx.closePath();
    ctx.fill();
  }

  drawCodeSymbols(ctx, x, y, size, color) {
    ctx.fillStyle = `${color}66`;
    ctx.font = `${size * 0.2}px "SF Mono", Monaco, "Cascadia Code", monospace`;

    const symbols = ['</>', '{}', '[]', '()'];
    const positions = [
      { x: x + size * 0.2, y: y + size * 0.3 },
      { x: x + size * 0.6, y: y + size * 0.3 },
      { x: x + size * 0.2, y: y + size * 0.7 },
      { x: x + size * 0.6, y: y + size * 0.7 }
    ];

    symbols.forEach((symbol, index) => {
      const pos = positions[index];
      ctx.fillText(symbol, pos.x, pos.y);
    });
  }

  async generateScreenshots() {
    console.log('📸 Generating screenshots...');

    const screenshotConfigs = [
      {
        name: 'hero-screenshot',
        description: 'Main interface with file tree and preview',
        setup: this.setupHeroScreenshot.bind(this)
      },
      {
        name: 'file-selection',
        description: 'Interactive file selection with checkboxes',
        setup: this.setupFileSelectionScreenshot.bind(this)
      },
      {
        name: 'remote-repository',
        description: 'Remote repository loading interface',
        setup: this.setupRemoteRepoScreenshot.bind(this)
      },
      {
        name: 'output-formats',
        description: 'Multiple output format examples',
        setup: this.setupOutputFormatsScreenshot.bind(this)
      },
      {
        name: 'jupyter-support',
        description: 'Jupyter notebook processing',
        setup: this.setupJupyterScreenshot.bind(this)
      },
      {
        name: 'performance-dashboard',
        description: 'Performance monitoring dashboard',
        setup: this.setupPerformanceScreenshot.bind(this)
      }
    ];

    for (const config of screenshotConfigs) {
      const canvas = createCanvas(1200, 800);
      const ctx = canvas.getContext('2d');

      await config.setup(ctx, canvas);
      this.addScreenshotAnnotations(ctx, config.description);
      await this.saveCanvas(canvas, `screenshots/${config.name}.png`);

      const thumbnailCanvas = createCanvas(400, 267);
      const thumbnailCtx = thumbnailCanvas.getContext('2d');
      thumbnailCtx.drawImage(canvas, 0, 0, 1200, 800, 0, 0, 400, 267);
      await this.saveCanvas(thumbnailCanvas, `screenshots/${config.name}-thumb.png`);
    }
  }

  setupHeroScreenshot(ctx, canvas) {
    const { width, height } = canvas;
    ctx.save();

    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, width, height);

    this.drawVSCodeChrome(ctx, width, height);
    this.drawSidebar(ctx, 0, 50, 300, height - 50);
    this.drawFileTreeInterface(ctx, 300, 50, 500, height - 50);
    this.drawPreviewPanel(ctx, 800, 50, 400, height - 50, {
      title: 'Knowledge Base Digest',
      language: 'markdown'
    });

    ctx.restore();
  }

  setupFileSelectionScreenshot(ctx, canvas) {
    this.setupHeroScreenshot(ctx, canvas);
    this.drawCallout(ctx, {
      x: 320,
      y: 160,
      width: 440,
      height: 360,
      title: 'Smart File Selection',
      message: 'Auto-detects relevant files and preserves project structure.'
    });
  }

  setupRemoteRepoScreenshot(ctx, canvas) {
    const { width, height } = canvas;
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, width, height);

    this.drawVSCodeChrome(ctx, width, height);
    this.drawSidebar(ctx, 0, 50, 300, height - 50);

    this.drawRemoteRepoPanel(ctx, 300, 50, 900, height - 50);
  }

  setupOutputFormatsScreenshot(ctx, canvas) {
    const { width, height } = canvas;
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, width, height);
    this.drawVSCodeChrome(ctx, width, height);

    const panelWidth = width / 3;
    const formats = [
      { title: 'Markdown Digest', language: 'markdown' },
      { title: 'JSON Summary', language: 'json' },
      { title: 'Plain Text Brief', language: 'text' }
    ];

    formats.forEach((format, index) => {
      this.drawPreviewPanel(
        ctx,
        index * panelWidth,
        50,
        panelWidth,
        height - 50,
        format
      );
    });
  }

  setupJupyterScreenshot(ctx, canvas) {
    const { width, height } = canvas;
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, width, height);
    this.drawVSCodeChrome(ctx, width, height);

    this.drawNotebookPanel(ctx, 0, 50, width, height - 50);
  }

  setupPerformanceScreenshot(ctx, canvas) {
    const { width, height } = canvas;
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, width, height);
    this.drawVSCodeChrome(ctx, width, height);

    this.drawPerformanceDashboard(ctx, 0, 50, width, height - 50);
  }

  drawVSCodeChrome(ctx, width, height) {
    ctx.fillStyle = '#323233';
    ctx.fillRect(0, 0, width, 50);

    const controls = ['#FF5F57', '#FFBD2E', '#28CA42'];
    controls.forEach((color, index) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(20 + index * 20, 25, 6, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = '#CCCCCC';
    ctx.font = '14px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('Visual Studio Code — Code Ingest Demo Workspace', width / 2 - 180, 30);
  }

  drawSidebar(ctx, x, y, width, height) {
    ctx.fillStyle = '#252526';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#333334';
    ctx.fillRect(x, y, 50, height);

    ctx.fillStyle = this.brandColors.primary;
    ctx.fillRect(x + 10, y + 20, 30, 30);

    ctx.fillStyle = '#37373D';
    ctx.fillRect(x + 50, y, width - 50, 35);
    ctx.fillStyle = '#CCCCCC';
    ctx.font = '13px sans-serif';
    ctx.fillText('CODE INGEST', x + 60, y + 22);
  }

  drawFileTreeInterface(ctx, x, y, width, height) {
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#2D2D30';
    ctx.fillRect(x, y, width, 40);

    ctx.fillStyle = this.brandColors.primary;
    ctx.fillRect(x + 20, y + 8, 140, 24);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px sans-serif';
    ctx.fillText('Generate Digest', x + 35, y + 24);

    this.drawFileTree(ctx, x + 20, y + 60, width - 40, height - 100);
  }

  drawFileTree(ctx, x, y, width, height) {
    const files = [
      { name: '📁 src', level: 0, checked: true },
      { name: '📄 extension.ts', level: 1, checked: true },
      { name: '📁 services', level: 1, checked: true },
      { name: '📄 fileScanner.ts', level: 2, checked: true },
      { name: '📄 digestGenerator.ts', level: 2, checked: true },
      { name: '📁 notebooks', level: 1, checked: false },
      { name: '📄 README.md', level: 0, checked: true },
      { name: '📄 package.json', level: 0, checked: true }
    ];

    const lineHeight = 26;
    files.forEach((file, index) => {
      const fileY = y + index * lineHeight;
      const indent = file.level * 24;

      const checkboxSize = 16;
      ctx.strokeStyle = '#6E7681';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + indent, fileY, checkboxSize, checkboxSize);

      if (file.checked) {
        ctx.fillStyle = this.brandColors.primary;
        ctx.fillRect(x + indent + 2, fileY + 2, checkboxSize - 4, checkboxSize - 4);

        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + indent + 4, fileY + 9);
        ctx.lineTo(x + indent + 7, fileY + 13);
        ctx.lineTo(x + indent + 12, fileY + 5);
        ctx.stroke();
      }

      ctx.fillStyle = file.checked ? '#CCCCCC' : '#808080';
      ctx.font = '13px "SF Mono", Monaco, "Cascadia Code", monospace';
      ctx.fillText(file.name, x + indent + 24, fileY + checkboxSize - 2);
    });
  }

  drawPreviewPanel(ctx, x, y, width, height, options = {}) {
    ctx.save();
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#2D2D30';
    ctx.fillRect(x, y, width, 40);

    ctx.fillStyle = '#CCCCCC';
    ctx.font = '13px sans-serif';
    ctx.fillText(options.title || 'Generated Digest Preview', x + 20, y + 24);

    ctx.fillStyle = '#1A1A1A';
    ctx.fillRect(x + 20, y + 60, width - 40, height - 100);

    ctx.fillStyle = '#CCCCCC';
    ctx.font = '12px "SF Mono", Monaco, "Cascadia Code"';
    const content = this.samplePreviewContent(options.language);
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      ctx.fillText(line, x + 40, y + 90 + index * 20);
    });

    ctx.restore();
  }

  drawRemoteRepoPanel(ctx, x, y, width, height) {
    ctx.save();

    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#2D2D30';
    ctx.fillRect(x, y, width, 60);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '18px sans-serif';
    ctx.fillText('Remote Repository Ingestion', x + 20, y + 38);

    ctx.fillStyle = '#252526';
    ctx.fillRect(x + 20, y + 80, width - 40, 80);
    ctx.fillStyle = '#CCCCCC';
    ctx.font = '14px sans-serif';
    ctx.fillText('Repository URL', x + 40, y + 108);
    ctx.fillStyle = '#1A1A1A';
    ctx.fillRect(x + 40, y + 120, width - 120, 30);
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText('https://github.com/your-org/knowledge-base.git', x + 50, y + 140);

    ctx.fillStyle = this.brandColors.primary;
    ctx.fillRect(x + width - 200, y + 120, 140, 30);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Ingest Repository', x + width - 188, y + 140);

    ctx.fillStyle = '#252526';
    ctx.fillRect(x + 20, y + 190, width - 40, height - 210);
    ctx.fillStyle = '#CCCCCC';
    ctx.fillText('Recent Ingestions', x + 40, y + 220);

    const rows = [
      { repo: 'github.com/code-ingest/docs', status: 'Processed 12m ago', statusColor: this.brandColors.success },
      { repo: 'github.com/docs/architecture', status: 'Queued 1m ago', statusColor: this.brandColors.warning }
    ];

    rows.forEach((row, index) => {
      const rowY = y + 250 + index * 70;
      ctx.fillStyle = '#1A1A1A';
      ctx.fillRect(x + 40, rowY, width - 80, 50);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(row.repo, x + 60, rowY + 22);
      ctx.fillStyle = row.statusColor;
      ctx.fillText(row.status, x + 60, rowY + 40);
    });

    ctx.restore();
  }

  drawNotebookPanel(ctx, x, y, width, height) {
    ctx.save();
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#2D2D30';
    ctx.fillRect(x, y, width, 50);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '16px sans-serif';
    ctx.fillText('Notebook Analysis', x + 20, y + 32);

    const cellHeight = 140;
    for (let i = 0; i < 4; i++) {
      const cellY = y + 70 + i * (cellHeight + 20);
      const cellType = i % 2 === 0 ? 'Code Cell' : 'Markdown Cell';
      ctx.fillStyle = '#1A1A1A';
      ctx.fillRect(x + 20, cellY, width - 40, cellHeight);
      ctx.fillStyle = this.brandColors.accent;
      ctx.fillRect(x + 20, cellY, 6, cellHeight);
      ctx.fillStyle = '#CCCCCC';
      ctx.font = '14px "SF Mono", Monaco, "Cascadia Code"';
      ctx.fillText(`${cellType} ${i + 1}`, x + 40, cellY + 30);
      ctx.fillStyle = '#AAAAAA';
      ctx.fillText('... content truncated for digest ...', x + 40, cellY + 60);
    }

    ctx.restore();
  }

  drawPerformanceDashboard(ctx, x, y, width, height) {
    ctx.save();
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = '#2D2D30';
    ctx.fillRect(x, y, width, 50);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '18px sans-serif';
    ctx.fillText('Performance Dashboard', x + 20, y + 32);

    const stats = [
      { label: 'Files Processed', value: '245', color: this.brandColors.accent },
      { label: 'Generation Time', value: '12.4s', color: this.brandColors.primary },
      { label: 'Token Estimate', value: '18.2k', color: this.brandColors.success }
    ];

    stats.forEach((stat, index) => {
      const statX = x + 20 + index * 260;
      ctx.fillStyle = '#252526';
      ctx.fillRect(statX, y + 70, 240, 100);
      ctx.fillStyle = stat.color;
      ctx.font = '28px sans-serif';
      ctx.fillText(stat.value, statX + 20, y + 118);
      ctx.fillStyle = '#CCCCCC';
      ctx.font = '14px sans-serif';
      ctx.fillText(stat.label, statX + 20, y + 140);
    });

    this.drawTrendChart(ctx, x + 20, y + 200, width - 40, height - 240);
    ctx.restore();
  }

  drawTrendChart(ctx, x, y, width, height) {
    ctx.save();
    ctx.fillStyle = '#252526';
    ctx.fillRect(x, y, width, height);

    ctx.strokeStyle = '#3F3F46';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const lineY = y + (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(x, lineY);
      ctx.lineTo(x + width, lineY);
      ctx.stroke();
    }

    const points = [
      { ingest: 10, performance: 220 },
      { ingest: 40, performance: 180 },
      { ingest: 90, performance: 150 },
      { ingest: 150, performance: 130 },
      { ingest: 220, performance: 120 }
    ];

    ctx.strokeStyle = this.brandColors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => {
      const pointX = x + (width / (points.length - 1)) * index;
      const pointY = y + height - (point.performance / 250) * height;
      if (index === 0) {
        ctx.moveTo(pointX, pointY);
      } else {
        ctx.lineTo(pointX, pointY);
      }
    });
    ctx.stroke();

    ctx.fillStyle = this.brandColors.accent;
    points.forEach((point, index) => {
      const pointX = x + (width / (points.length - 1)) * index;
      const pointY = y + height - (point.performance / 250) * height;
      ctx.beginPath();
      ctx.arc(pointX, pointY, 5, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  drawCallout(ctx, { x, y, width, height, title, message }) {
    ctx.save();
    ctx.strokeStyle = this.brandColors.accent;
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);

    ctx.fillStyle = '#00000088';
    ctx.fillRect(x + width + 20, y + height / 2 - 40, 260, 120);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '18px sans-serif';
    ctx.fillText(title, x + width + 40, y + height / 2 - 10);
    ctx.fillStyle = '#CCCCCC';
    ctx.font = '14px sans-serif';
    ctx.fillText(message, x + width + 40, y + height / 2 + 20);
    ctx.restore();
  }

  addScreenshotAnnotations(ctx, description) {
    ctx.save();
    ctx.fillStyle = '#00000099';
    ctx.fillRect(0, 0, 380, 70);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 20px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('Code Ingest — Marketplace Preview', 20, 35);

    ctx.fillStyle = '#CCCCCC';
    ctx.font = '14px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(description, 20, 55);
    ctx.restore();
  }

  samplePreviewContent(language) {
    if (language === 'json') {
      return '{\n  "summary": "Processed 245 files in 12.4s",\n  "highlights": [\n    "Structured file tree selection",\n    "Remote repository ingestion",\n    "Multi-format export"\n  ]\n}';
    }

    if (language === 'text') {
      return 'CODE INGEST DIGEST\n===================\n\n• Files processed: 245\n• Generation time: 12.4s\n• Formats: Markdown, JSON, Text';
    }

    return '# Code Ingest Digest\n\n- Remote repository: `knowledge-base`\n- Selected files: 245\n- Generation time: **12.4 seconds**\n- Output formats: Markdown, JSON, Plain text';
  }

  async generatePromotionalGraphics() {
    console.log('🎨 Generating promotional graphics...');

    const bannerCanvas = createCanvas(1200, 400);
    const bannerCtx = bannerCanvas.getContext('2d');
    await this.createHeroBanner(bannerCtx, bannerCanvas);
    await this.saveCanvas(bannerCanvas, 'promotional/hero-banner.png');

    const features = [
      { name: 'file-tree-selection', icon: '🌳', description: 'Interactive file selection with smart filtering' },
      { name: 'remote-repositories', icon: '🌐', description: 'Clone and process repositories from GitHub & GitLab' },
      { name: 'multiple-formats', icon: '📄', description: 'Export documentation-ready Markdown, JSON, and text' },
      { name: 'jupyter-support', icon: '📓', description: 'Comprehensive notebook summarisation and conversion' }
    ];

    for (const feature of features) {
      const featureCanvas = createCanvas(600, 300);
      const featureCtx = featureCanvas.getContext('2d');
      await this.createFeatureGraphic(featureCtx, featureCanvas, feature);
      await this.saveCanvas(featureCanvas, `promotional/feature-${feature.name}.png`);
    }
  }

  async createHeroBanner(ctx, canvas) {
    const { width, height } = canvas;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#1E1E1E');
    gradient.addColorStop(1, '#2D2D30');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 56px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Code Ingest', width / 2, height / 2 - 60);

    ctx.fillStyle = '#CCCCCC';
    ctx.font = '24px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('Professional Codebase Digest Generation', width / 2, height / 2 - 10);

    ctx.fillStyle = this.brandColors.accent;
    ctx.font = '18px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('🚀 Remote Repositories   📊 Multiple Formats   📓 Jupyter Support   ⚡ Performance Insights', width / 2, height / 2 + 40);

    const iconPath = path.join(__dirname, '..', '..', 'resources', 'icons', 'icon.png');
    try {
      const iconImage = await loadImage(iconPath);
      const iconSize = 160;
      ctx.drawImage(iconImage, width / 2 - iconSize / 2, height / 2 + 70, iconSize, iconSize);
    } catch (error) {
      ctx.fillStyle = '#FFFFFF33';
      ctx.font = '120px sans-serif';
      ctx.fillText('</>', width / 2, height / 2 + 150);
    }
  }

  async createFeatureGraphic(ctx, canvas, feature) {
    const { width, height } = canvas;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#1E1E1E');
    gradient.addColorStop(1, '#252526');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = this.brandColors.accent;
    ctx.font = '72px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(feature.icon, 40, height / 2 - 10);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '32px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(feature.name.replace(/-/g, ' '), 120, height / 2 - 30);

    ctx.fillStyle = '#CCCCCC';
    ctx.font = '18px -apple-system, "Segoe UI", sans-serif';
    this.wrapText(ctx, feature.description, 120, height / 2 + 10, width - 160, 26);

    ctx.strokeStyle = this.brandColors.primary;
    ctx.lineWidth = 2;
    ctx.strokeRect(20, 20, width - 40, height - 40);
  }

  wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';

    words.forEach((word) => {
      const testLine = `${line}${word} `;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth) {
        ctx.fillText(line.trim(), x, y);
        line = `${word} `;
        y += lineHeight;
      } else {
        line = testLine;
      }
    });

    ctx.fillText(line.trim(), x, y);
  }

  async generateMarketingMaterials() {
    console.log('📝 Generating marketing materials...');
    await this.generateEnhancedPackageJson();
    await this.generateMarketplaceReadme();
    await this.generateChangelog();
    await this.generateContributingGuide();
  }

  async generateEnhancedPackageJson() {
    const sourcePath = path.join(__dirname, '..', '..', 'package.json');
    const outputPath = path.join(this.outputDir, 'marketing', 'package.marketplace.json');
    const raw = await fs.readFile(sourcePath, 'utf8');
    const pkg = JSON.parse(raw);

    const enhanced = {
      ...pkg,
      preview: true,
      qna: 'marketplace',
      badges: [
        { url: 'https://img.shields.io/badge/docs-code--ingest-blue', description: 'Documentation badge' },
        { url: 'https://img.shields.io/badge/tests-coverage-green', description: 'Unit test coverage' }
      ],
      categories: Array.from(new Set([...(pkg.categories || []), 'Productivity', 'Source Control'])),
      keywords: Array.from(new Set([...(pkg.keywords || []), 'automation', 'marketplace', 'digest', 'documentation']))
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(enhanced, null, 2)}\n`);
  }

  async generateMarketplaceReadme() {
    const outputPath = path.join(this.outputDir, 'marketing', 'MARKETPLACE_README.md');
    const content = `# Code Ingest

**Professional codebase digest generation for development and documentation teams.**

![Hero Banner](../promotional/hero-banner.png)

## Why Code Ingest

- ⚡ **Accelerate onboarding** with curated, up-to-date codebase summaries.
- 🌐 **Ingest remote repositories** directly from GitHub, GitLab, and self-hosted instances.
- 📚 **Document notebooks** alongside TypeScript, Python, and Markdown files.
- 🎯 **Flexible exports** including Markdown, JSON, and plain text digests.
- 📊 **Performance insights** with run history, token estimates, and throughput metrics.

## Key Features

| Feature | Description |
| --- | --- |
| Smart File Selection | Filter and prioritise files using tree-based selectors with rich metadata. |
| Remote Repository Support | Fetch partial clones, sparse checkouts, and branch pinning for targeted analysis. |
| Jupyter Notebook Processing | Split, annotate, and summarise executed notebooks with output preservation. |
| Output Flexibility | Render documentation-ready Markdown, ingestion-ready JSON, or concise briefs. |
| Performance Dashboard | Monitor generation times, file counts, and token estimates across runs. |

## Screenshots

![Main Interface](../screenshots/hero-screenshot.png)
![Remote Repository Loading](../screenshots/remote-repository.png)
![Performance Dashboard](../screenshots/performance-dashboard.png)

## Get Started

1. Install **Code Ingest** from the VS Code Marketplace.
2. Open the **Code Ingest** panel from the activity bar.
3. Select repository or files to ingest.
4. Choose your desired output format and generate professional documentation in seconds.

## Support & Feedback

- 📘 Documentation: https://github.com/your-org/code-ingest#readme
- 🐛 Issues: https://github.com/your-org/code-ingest/issues
- 💬 Discussions: marketplace Q&A tab

---

Code Ingest is crafted for documentation teams, developer advocates, and engineers shipping high-quality knowledge bases.`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${content}\n`);
  }

  async generateChangelog() {
    const outputPath = path.join(this.outputDir, 'marketing', 'MARKETPLACE_CHANGELOG.md');
    const content = `# Changelog

All notable changes to the **Code Ingest** marketplace release will be documented in this file.

## [1.0.0] - ${new Date().toISOString().split('T')[0]}

### Added
- Initial marketplace release with remote repository ingestion.
- Smart file tree selection with checkbox hierarchy.
- Multi-format digest export (Markdown, JSON, text).
- Jupyter notebook processing pipeline.
- Performance dashboard with metrics timeline.
`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content);
  }

  async generateContributingGuide() {
    const outputPath = path.join(this.outputDir, 'marketing', 'CONTRIBUTING.md');
    const content = `# Contributing to Code Ingest

We welcome contributions that improve Code Ingest documentation assets, automation, and marketing materials.

## Workflow

1. Fork the repository and create a feature branch.
2. Run \`npm install\` followed by \`npm run build:webview\`.
3. Generate marketplace assets with \`node scripts/assets/assetGenerator.js\`.
4. Run \`npm run test:unit\` to validate the codebase.
5. Submit a pull request with screenshots or generated assets attached.

## Asset Guidelines

- Icons should maintain the VS Code blue accent (#007ACC) and dark background palette.
- Screenshots must use 1200x800 resolution with annotations for clarity.
- Promotional graphics should highlight tangible user value in under 20 words.
- Marketing copy should remain concise, action-oriented, and accessible.

Thank you for helping developers ship better documentation with Code Ingest!`;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${content}\n`);
  }

  async optimizeAssets() {
    console.log('🔧 Optimizing assets...');

    const assetDirs = ['icons', 'screenshots', 'promotional'];
    for (const dir of assetDirs) {
      const dirPath = path.join(this.outputDir, dir);
      let files = [];
      try {
        files = await fs.readdir(dirPath);
      } catch (error) {
        continue;
      }

      for (const file of files) {
        if (file.toLowerCase().endsWith('.png')) {
          const filePath = path.join(dirPath, file);
          await this.optimizePNG(filePath);
        }
      }
    }
  }

  async optimizePNG(filePath) {
    const buffer = await fs.readFile(filePath);
    const optimized = await sharp(buffer)
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toBuffer();

    await fs.writeFile(filePath, optimized);
  }

  async generateAssetManifest() {
    const manifest = {
      generatedAt: new Date().toISOString(),
      version: '1.0.0',
      assets: {
        icons: await this.listFiles('icons'),
        screenshots: await this.listFiles('screenshots'),
        promotional: await this.listFiles('promotional')
      },
      metadata: {
        brandColors: this.brandColors,
        iconSizes: this.iconSizes,
        totalAssets: 0
      }
    };

    manifest.metadata.totalAssets = Object.values(manifest.assets).reduce(
      (sum, files) => sum + files.length,
      0
    );

    await fs.writeFile(
      path.join(this.outputDir, 'asset-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  async listFiles(relativeDir) {
    try {
      const dirPath = path.join(this.outputDir, relativeDir);
      const files = await fs.readdir(dirPath);
      return files.filter((file) => !file.startsWith('.')).sort();
    } catch (error) {
      return [];
    }
  }

  async saveCanvas(canvas, relativePath) {
    const outPath = path.join(this.outputDir, relativePath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const buffer = canvas.toBuffer('image/png');
    await fs.writeFile(outPath, buffer);
  }
}

module.exports = { MarketplaceAssetGenerator };

if (require.main === module) {
  (async () => {
    try {
      const generator = new MarketplaceAssetGenerator();
      await generator.generateAllAssets();
    } catch (error) {
      console.error('❌ Failed to generate marketplace assets:', error);
      process.exitCode = 1;
    }
  })();
}