const path = require("node:path");
const webpack = require("webpack");

module.exports = {
  name: "extension-host",
  target: "node",
  mode: "production",
  entry: "./src/extension.ts",
  devtool: "nosources-source-map",
  output: {
    filename: "extension.js",
    path: path.resolve(__dirname, "out"),
    libraryTarget: "commonjs2",
    clean: true
  },
  externals: {
    vscode: "commonjs vscode",
    "better-sqlite3": "commonjs better-sqlite3"
  },
  resolve: {
    extensions: [".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.ts$/u,
        exclude: /node_modules/u,
        use: [
          {
            loader: "ts-loader",
            options: {
              configFile: "tsconfig.json",
              transpileOnly: false
            }
          }
        ]
      }
    ]
  },
  plugins: [new webpack.ProgressPlugin()],
  stats: "minimal"
};
