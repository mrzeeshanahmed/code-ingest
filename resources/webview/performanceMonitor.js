/*
 * Follow instructions in copilot-instructions.md exactly.
 */

/**
 * Performance monitor used to collect metrics about critical webview operations.
 */
export class WebviewPerformanceMonitor {
  /**
   * @param {{
   *   reportPerformanceIssue: (operation: string, duration: number, threshold: number) => void;
   * }} errorReporter
   * @param {{ debug: (message: string, ...args: unknown[]) => void }} logger
   */
  constructor(errorReporter, logger) {
    this.errorReporter = errorReporter;
    this.logger = logger;
    this.performanceData = [];
    this.thresholds = {
      domUpdate: 100,
      stateUpdate: 50,
      messageProcessing: 200,
      rendering: 500,
      initialization: 1000
    };
  }

  /**
   * Measure the duration and memory delta for an operation.
   * @template T
   * @param {string} name
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  async measureOperation(name, operation, metadata = undefined) {
    return this.#measure(name, operation, metadata, true);
  }

  measureSync(name, operation, metadata = undefined) {
    return this.#measure(name, operation, metadata, false);
  }

  async #measure(name, operation, metadata, usePromise) {
    const startTime = performance.now();
    const startMemory = this.getMemoryUsage();

    let result;
    let error;

    const runner = () => {
      try {
        result = operation();
      } catch (err) {
        error = err;
      }
    };

    if (usePromise) {
      await Promise.resolve().then(runner);
    } else {
      runner();
    }

    const endTime = performance.now();
    const endMemory = this.getMemoryUsage();
    const duration = endTime - startTime;

    const measurement = {
      name,
      duration,
      memoryDelta: endMemory - startMemory,
      timestamp: Date.now(),
      metadata: metadata ?? undefined
    };

    this.performanceData.push(measurement);
    this.checkThresholds(name, duration);

    try {
      this.logger?.debug?.(`Performance: ${name} took ${duration.toFixed(2)}ms`, measurement);
    } catch (logError) {
      console.warn("Failed to log performance measurement", logError);
    }

    if (error) {
      throw error;
    }

    return result;
  }

  checkThresholds(operation, duration) {
    const threshold = this.thresholds[operation];
    if (typeof threshold === "number" && duration > threshold) {
      this.errorReporter?.reportPerformanceIssue(operation, duration, threshold);
    }
  }

  getMemoryUsage() {
    if (performance?.memory && typeof performance.memory.usedJSHeapSize === "number") {
      return performance.memory.usedJSHeapSize;
    }
    return 0;
  }

  getPerformanceReport() {
    const now = Date.now();
    const recentData = this.performanceData.filter((item) => now - item.timestamp < 60_000);

    const operationStats = {};
    for (const item of recentData) {
      if (!operationStats[item.name]) {
        operationStats[item.name] = {
          count: 0,
          totalDuration: 0,
          maxDuration: 0,
          memoryUsage: []
        };
      }
      const stats = operationStats[item.name];
      stats.count += 1;
      stats.totalDuration += item.duration;
      stats.maxDuration = Math.max(stats.maxDuration, item.duration);
      stats.memoryUsage.push(item.memoryDelta);
    }

    return {
      operationStats,
      totalOperations: recentData.length,
      averageMemoryUsage: this.getMemoryUsage(),
      timestamp: now
    };
  }
}

export function createWebviewPerformanceMonitor(errorReporter, logger) {
  return new WebviewPerformanceMonitor(errorReporter, logger);
}
