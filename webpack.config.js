// Production-grade Webpack configuration for the Code Ingest VS Code extension.
// The file exports two compiler configs:
//  1) Extension host bundle (executes in VS Code's Node.js runtime)
//  2) Webview asset pipeline (copies static assets + produces an externals manifest)

const path = require('node:path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');

const isProd = process.env.NODE_ENV === 'production';
const shouldAnalyze = process.env.ANALYZE === 'true';

const extensionOutDir = path.resolve(__dirname, 'out');
const webviewSourceDir = path.resolve(__dirname, 'resources', 'webview');

// Custom plugin to emit a manifest that VS Code can load to map copied webview resources.
class WebviewExternalsReportPlugin {
  constructor(options = {}) {
    this.manifestAsset = options.manifestAsset ?? 'resources/webview/externals.json';
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap('WebviewExternalsReportPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'WebviewExternalsReportPlugin',
          stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
        },
        () => {
          const manifest = {};

          for (const asset of compilation.getAssets()) {
            if (!asset.name.startsWith('resources/webview/')) {
              continue;
            }

            const relativePath = asset.name.replace(/^resources\/(?:webview\/)+/, '');
            if (!relativePath || relativePath === 'externals.json') {
              continue;
            }

            manifest[relativePath] = asset.name;
          }

          const manifestSource = new webpack.sources.RawSource(
            `${JSON.stringify({ resources: manifest }, null, 2)}\n`
          );

          compilation.emitAsset(this.manifestAsset, manifestSource);
        }
      );
    });
  }
}

// Shared helper to append opt-in bundle analysis while keeping configs tidy.
function withOptionalAnalyzer(plugins, reportName) {
  if (shouldAnalyze) {
    plugins.push(
      new BundleAnalyzerPlugin({
        analyzerMode: 'static',
        openAnalyzer: false,
        reportFilename: path.join(extensionOutDir, reportName)
      })
    );
  }

  return plugins;
}

// -------------------------------------------------------------------------------------
// Extension host bundle: this is the entry point executed by VS Code in a Node context.
// -------------------------------------------------------------------------------------
const extensionConfig = {
  name: 'extension-host',
  target: 'node',
  mode: isProd ? 'production' : 'development',
  entry: './src/extension.ts',
  devtool: isProd ? 'nosources-source-map' : 'source-map',
  output: {
    filename: 'extension.js',
    chunkFilename: '[name].js',
    path: extensionOutDir,
    libraryTarget: 'commonjs2',
    clean: true
  },
  externals: {
    vscode: 'commonjs vscode',
    '@dqbd/tiktoken': 'commonjs @dqbd/tiktoken'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/u,
        exclude: /node_modules/u,
        use: [
          {
            loader: 'ts-loader',
            options: {
              configFile: 'tsconfig.json',
              transpileOnly: false
            }
          }
        ]
      }
    ]
  },
  optimization: {
    // Split vendor modules into a secondary chunk when shipping production bits to
    // keep the main activation script snappy and enable incremental caching.
    splitChunks: isProd
      ? {
          chunks: 'all',
          minSize: 30_000,
          cacheGroups: {
            vendors: {
              test: /[\\/]node_modules[\\/]/u,
              name: 'extension.vendors',
              enforce: true,
              priority: -10
            }
          }
        }
      : false,
    minimize: isProd,
    // Tree-shaking signals for Webpack + Terser
    usedExports: true,
    sideEffects: true
  },
  experiments: {
    topLevelAwait: false
  },
  performance: {
    hints: isProd ? 'warning' : false
  },
  plugins: withOptionalAnalyzer([
    new webpack.ProgressPlugin()
  ], 'extension-bundle-report.html'),
  stats: 'minimal'
};

// -------------------------------------------------------------------------------------
// Webview asset pipeline: copies static assets and emits an externals manifest VS Code
// can consume when injecting resources into the sandboxed iframe.
// -------------------------------------------------------------------------------------
const webviewAssetsConfig = {
  name: 'webview-assets',
  target: 'web',
  mode: isProd ? 'production' : 'development',
  entry: {},
  devtool: 'source-map',
  output: {
    path: extensionOutDir,
    filename: '[name].js',
    clean: false
  },
  optimization: {
    minimize: isProd,
    splitChunks: false
  },
  plugins: withOptionalAnalyzer(
    [
      new webpack.ProgressPlugin(),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: '**/*.{html,js,css,json}',
            context: webviewSourceDir,
            to: path.posix.join('resources/webview', '[path][name][ext]'),
            noErrorOnMissing: true,
            globOptions: {
              dot: false
            }
          }
        ]
      }),
      new WebviewExternalsReportPlugin({
        manifestAsset: 'resources/webview/externals.json'
      })
    ],
    'webview-bundle-report.html'
  ),
  resolve: {
    extensions: ['.ts', '.js', '.jsx', '.tsx', '.json']
  },
  stats: 'minimal'
};

module.exports = [extensionConfig, webviewAssetsConfig];
