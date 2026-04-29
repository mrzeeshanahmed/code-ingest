'use strict';

const fs = require('fs').promises;
const path = require('path');

class AutomatedScreenshotCapture {
  constructor() {
    this.puppeteer = require('puppeteer');
    this.extensionPath = path.join(__dirname, '..', '..');
    this.outputDir = path.join(this.extensionPath, 'marketplace-assets', 'screenshots', 'real');
  }

  async captureRealScreenshots() {
    await fs.mkdir(this.outputDir, { recursive: true });

    const browser = await this.puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1200, height: 800 },
      args: [`--disable-extensions-except=${this.extensionPath}`, `--load-extension=${this.extensionPath}`]
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });

      await this.setupTestWorkspace(page);
      await this.captureHeroScreenshot(page);
      await this.captureFileSelectionScreenshot(page);
      await this.capturePerformanceScreenshot(page);
    } finally {
      await browser.close();
    }
  }

  async setupTestWorkspace(page) {
    const webviewPath = path.join(this.extensionPath, 'resources', 'webview', 'index.html');
    const fileUrl = `file://${webviewPath.replace(/\\/g, '/')}`;

    await page.goto(fileUrl, { waitUntil: 'networkidle0' });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      document.body.dataset.marketplacePreview = 'true';
    });
  }

  async captureHeroScreenshot(page) {
    const targetPath = path.join(this.outputDir, 'hero-screenshot.png');
    await this.highlightElement(page, '.app-shell');
    await page.screenshot({ path: targetPath, fullPage: true });
  }

  async captureFileSelectionScreenshot(page) {
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('codeIngest:populate-demo-data'));
    });
    await page.waitForTimeout(500);

    const targetPath = path.join(this.outputDir, 'file-selection.png');
    await this.highlightElement(page, '.tree-view');
    await page.screenshot({ path: targetPath, fullPage: true });
  }

  async capturePerformanceScreenshot(page) {
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('codeIngest:show-performance-demo'));
    });
    await page.waitForTimeout(500);

    const targetPath = path.join(this.outputDir, 'performance-dashboard.png');
    await this.highlightElement(page, '.performance-dashboard');
    await page.screenshot({ path: targetPath, fullPage: true });
  }

  async highlightElement(page, selector) {
    await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) {
        return;
      }
      node.style.outline = '4px solid #00D2B8';
      node.style.outlineOffset = '6px';
    }, selector);
  }
}

module.exports = { AutomatedScreenshotCapture };

if (require.main === module) {
  (async () => {
    try {
      const capture = new AutomatedScreenshotCapture();
      await capture.captureRealScreenshots();
    } catch (error) {
      console.error('❌ Failed to capture screenshots:', error);
      process.exitCode = 1;
    }
  })();
}