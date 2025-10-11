import type { Bottleneck, OptimizationRecommendation } from "../performanceMonitor";

export interface MemoryUsageSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface ActiveOperation {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  duration: number;
  progress?: number | undefined;
  metadata?: Record<string, unknown>;
  memory?: MemoryUsageSnapshot;
}

export interface OperationSummary {
  id: string;
  name: string;
  startedAt: number;
  duration: number;
  status: "completed" | "failed";
  metadata?: Record<string, unknown>;
}

export interface TrendData {
  timestamp: number;
  value: number;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface RegressionData {
  operation: string;
  baseline: number;
  current: number;
  change: number;
  severity: "low" | "medium" | "high";
  detectedAt: number;
  metadata?: Record<string, unknown>;
}

export type PerformanceRecommendation = OptimizationRecommendation;

export interface PerformanceAlert {
  id: string;
  category: "cpu" | "memory" | "operation" | "system";
  severity: "info" | "warning" | "critical";
  message: string;
  details?: string;
  detectedAt: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryUsageOverview {
  heapTotal: number;
  heapUsed: number;
  rss: number;
  external: number;
  arrayBuffers: number;
}

export interface SystemMetrics {
  timestamp: number;
  cpuUsage: number;
  memory: MemoryUsageOverview;
  loadAverage?: number;
  eventLoopDelay?: number;
}

export interface DashboardMetrics {
  realTime: {
    currentOperations: ActiveOperation[];
    memoryUsage: MemoryUsageOverview;
    cpuUsage: number;
    queuedOperations: number;
    lastCompletedOperation?: OperationSummary;
  };
  session: {
    startTime: Date;
    duration: number;
    operationsCompleted: number;
    averageOperationTime: number;
    memoryPeak: number;
    errorsEncountered: number;
    filesProcessed: number;
  };
  historical: {
    operationTrends: TrendData[];
    memoryTrends: TrendData[];
    errorRates: TrendData[];
    performanceRegressions: RegressionData[];
  };
  insights: {
    bottlenecks: Bottleneck[];
    recommendations: PerformanceRecommendation[];
    alerts: PerformanceAlert[];
  };
}
