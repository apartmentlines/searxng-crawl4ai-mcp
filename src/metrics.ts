import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import express, { type Express, type Request, type Response } from 'express';
import { logger } from './logger.js';

export type MetricsServiceName = 'searxng' | 'crawl4ai';

export type SearxngEventType =
  | 'engine_attempted'
  | 'engine_succeeded'
  | 'engine_failed'
  | 'engine_cooldown_started'
  | 'engine_cooldown_skipped'
  | 'engine_cooldown_cleared';

export type Crawl4AIEventType =
  | 'scrape_attempted'
  | 'scrape_succeeded'
  | 'scrape_failed';

export interface SearxngMetricEvent {
  eventType: SearxngEventType;
  engine: string;
  query?: string;
  reason?: string;
  cooldownUntil?: Date;
  resultCount?: number;
}

export interface Crawl4AIMetricEvent {
  eventType: Crawl4AIEventType;
  url: string;
  statusCode?: number;
  error?: string;
  returnedBytes?: number;
}

export interface MetricsRecorder {
  recordSearxngEvent(event: SearxngMetricEvent): Promise<void>;
  recordCrawl4AIEvent(event: Crawl4AIMetricEvent): Promise<void>;
}

interface RunMarker {
  service: MetricsServiceName;
  runKey: string;
  startedAt: string;
}

interface RunRow {
  id: number;
  service: MetricsServiceName;
  run_key: string;
  started_at: string;
  observed_at: string;
}

interface SearxngEngineRow {
  engine: string;
  attempts: number;
  successes: number;
}

interface Crawl4AIRow {
  attempts: number;
  successes: number;
  returned_bytes: number;
}

interface CoolingRow {
  engine: string;
  event_type: SearxngEventType;
  reason: string | null;
  cooldown_until: string | null;
}

export class NullMetricsRecorder implements MetricsRecorder {
  async recordSearxngEvent(_event: SearxngMetricEvent): Promise<void> {
    return;
  }

  async recordCrawl4AIEvent(_event: Crawl4AIMetricEvent): Promise<void> {
    return;
  }
}

export class MetricsService implements MetricsRecorder {
  private db: Database.Database;
  private runStateDir: string;

  constructor(dbPath: string = getMetricsDbPath()) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runStateDir = getRunStateDir();
    this.initializeSchema();
  }

  async recordSearxngEvent(event: SearxngMetricEvent): Promise<void> {
    try {
      const runId = this.resolveCurrentRunId('searxng');
      if (runId === null) {
        return;
      }

      this.db.prepare(`
        INSERT INTO searxng_events (
          run_id, occurred_at, event_type, engine, query_hash, reason,
          cooldown_until, result_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        new Date().toISOString(),
        event.eventType,
        event.engine,
        event.query ? hashValue(event.query) : null,
        event.reason ?? null,
        event.cooldownUntil?.toISOString() ?? null,
        event.resultCount ?? null,
      );
    } catch (error) {
      logger.warn(`Unable to record SearXNG metric event: ${formatError(error)}`);
    }
  }

  async recordCrawl4AIEvent(event: Crawl4AIMetricEvent): Promise<void> {
    try {
      const runId = this.resolveCurrentRunId('crawl4ai');
      if (runId === null) {
        return;
      }

      this.db.prepare(`
        INSERT INTO crawl4ai_events (
          run_id, occurred_at, event_type, url_hash, status_code, error,
          returned_bytes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        new Date().toISOString(),
        event.eventType,
        hashValue(event.url),
        event.statusCode ?? null,
        event.error ?? null,
        event.returnedBytes ?? null,
      );
    } catch (error) {
      logger.warn(`Unable to record Crawl4AI metric event: ${formatError(error)}`);
    }
  }

  createApp(getSearxngEnabledEngines: () => Promise<string[]>): Express {
    const app = express();

    app.get('/metrics', async (request: Request, response: Response) => {
      try {
        const scope = typeof request.query.scope === 'string' ? request.query.scope : 'current';
        const report = await this.getMetricsReport(scope, request, getSearxngEnabledEngines);
        response.json(report);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(400).json({ error: message });
      }
    });

    return app;
  }

  startHttpServer(port: number, getSearxngEnabledEngines: () => Promise<string[]>): void {
    const app = this.createApp(getSearxngEnabledEngines);
    app.listen(port, () => {
      logger.info(`MCP metrics endpoint listening on port ${port}`);
    });
  }

  private async getMetricsReport(
    scope: string,
    request: Request,
    getSearxngEnabledEngines: () => Promise<string[]>,
  ): Promise<Record<string, unknown>> {
    if (scope === 'current') {
      const searxngRun = this.resolveCurrentRun('searxng');
      const crawl4aiRun = this.resolveCurrentRun('crawl4ai');
      const enabledEngines = await safeEnabledEngines(getSearxngEnabledEngines);

      return {
        scope,
        generated_at: new Date().toISOString(),
        searxng: this.buildSearxngReport(searxngRun?.id ? [searxngRun.id] : [], enabledEngines, searxngRun ?? undefined),
        crawl4ai: this.buildCrawl4AIReport(crawl4aiRun?.id ? [crawl4aiRun.id] : [], crawl4aiRun ?? undefined),
      };
    }

    if (scope === 'all_time') {
      const enabledEngines = await safeEnabledEngines(getSearxngEnabledEngines);
      return {
        scope,
        generated_at: new Date().toISOString(),
        searxng: this.buildSearxngReport(this.getRunIds('searxng'), enabledEngines),
        crawl4ai: this.buildCrawl4AIReport(this.getRunIds('crawl4ai')),
      };
    }

    if (scope === 'run') {
      const service = request.query.service;
      const runId = Number(request.query.run_id);
      if ((service !== 'searxng' && service !== 'crawl4ai') || !Number.isInteger(runId) || runId <= 0) {
        throw new Error('scope=run requires service=searxng|crawl4ai and a positive run_id');
      }

      const run = this.getRunById(runId, service);
      if (!run) {
        throw new Error(`No ${service} run found for run_id=${runId}`);
      }

      const enabledEngines = service === 'searxng'
        ? await safeEnabledEngines(getSearxngEnabledEngines)
        : [];
      return {
        scope,
        generated_at: new Date().toISOString(),
        [service]: service === 'searxng'
          ? this.buildSearxngReport([runId], enabledEngines, run)
          : this.buildCrawl4AIReport([runId], run),
      };
    }

    throw new Error('scope must be current, all_time, or run');
  }

  private buildSearxngReport(runIds: number[], enabledEngines: string[], currentRun?: RunRow): Record<string, unknown> {
    const engineRows = runIds.length > 0 ? this.getSearxngEngineRows(runIds) : [];
    const totalAttempts = sum(engineRows.map((row) => row.attempts));
    const totalSuccesses = sum(engineRows.map((row) => row.successes));
    const coolingEngines = runIds.length > 0 ? this.getCoolingEngines(runIds) : [];
    const coolingNames = new Set(coolingEngines.map((engine) => engine.engine));

    return {
      run: currentRun ? serializeRun(currentRun) : null,
      enabled_engines: enabledEngines,
      active_engines: enabledEngines.filter((engine) => !coolingNames.has(engine)),
      cooling_engines: coolingEngines,
      totals: {
        attempted_searches: totalAttempts,
        successful_searches: totalSuccesses,
        success_percentage: percentage(totalSuccesses, totalAttempts),
      },
      per_engine: engineRows.map((row) => ({
        engine: row.engine,
        attempted_searches: row.attempts,
        successful_searches: row.successes,
        success_percentage: percentage(row.successes, row.attempts),
      })),
    };
  }

  private buildCrawl4AIReport(runIds: number[], currentRun?: RunRow): Record<string, unknown> {
    const row = runIds.length > 0 ? this.getCrawl4AIRow(runIds) : { attempts: 0, successes: 0, returned_bytes: 0 };
    const totalReturnedMb = bytesToMb(row.returned_bytes);

    return {
      run: currentRun ? serializeRun(currentRun) : null,
      attempted_scrapes: row.attempts,
      successful_scrapes: row.successes,
      success_percentage: percentage(row.successes, row.attempts),
      total_returned_mb: totalReturnedMb,
      average_returned_mb: row.successes > 0 ? round(totalReturnedMb / row.successes) : 0,
    };
  }

  private getSearxngEngineRows(runIds: number[]): SearxngEngineRow[] {
    return this.db.prepare(`
      SELECT
        engine,
        SUM(CASE WHEN event_type = 'engine_attempted' THEN 1 ELSE 0 END) AS attempts,
        SUM(CASE WHEN event_type = 'engine_succeeded' THEN 1 ELSE 0 END) AS successes
      FROM searxng_events
      WHERE run_id IN (${placeholders(runIds)})
        AND event_type IN ('engine_attempted', 'engine_succeeded')
      GROUP BY engine
      ORDER BY engine
    `).all(...runIds) as SearxngEngineRow[];
  }

  private getCrawl4AIRow(runIds: number[]): Crawl4AIRow {
    return this.db.prepare(`
      SELECT
        SUM(CASE WHEN event_type = 'scrape_attempted' THEN 1 ELSE 0 END) AS attempts,
        SUM(CASE WHEN event_type = 'scrape_succeeded' THEN 1 ELSE 0 END) AS successes,
        COALESCE(SUM(CASE WHEN event_type = 'scrape_succeeded' THEN returned_bytes ELSE 0 END), 0) AS returned_bytes
      FROM crawl4ai_events
      WHERE run_id IN (${placeholders(runIds)})
    `).get(...runIds) as Crawl4AIRow;
  }

  private getCoolingEngines(runIds: number[]): Array<Record<string, unknown>> {
    const now = new Date();
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT
          engine,
          event_type,
          reason,
          cooldown_until,
          occurred_at,
          ROW_NUMBER() OVER (
            PARTITION BY engine
            ORDER BY occurred_at DESC, id DESC
          ) AS rn
        FROM searxng_events
        WHERE run_id IN (${placeholders(runIds)})
          AND event_type IN (
            'engine_cooldown_started',
            'engine_cooldown_skipped',
            'engine_cooldown_cleared',
            'engine_succeeded'
          )
      )
      SELECT engine, event_type, reason, cooldown_until
      FROM ranked
      WHERE rn = 1
        AND event_type IN ('engine_cooldown_started', 'engine_cooldown_skipped')
        AND cooldown_until > ?
      ORDER BY engine
    `).all(...runIds, now.toISOString()) as CoolingRow[];

    return rows.map((row) => ({
      engine: row.engine,
      reason: row.reason,
      cooldown_until: row.cooldown_until,
      retry_after_ms: row.cooldown_until
        ? Math.max(new Date(row.cooldown_until).getTime() - now.getTime(), 0)
        : 0,
    }));
  }

  private resolveCurrentRunId(service: MetricsServiceName): number | null {
    return this.resolveCurrentRun(service)?.id ?? null;
  }

  private resolveCurrentRun(service: MetricsServiceName): RunRow | null {
    const marker = this.readRunMarker(service);
    if (!marker) {
      return null;
    }

    const existing = this.db.prepare(`
      SELECT *
      FROM container_runs
      WHERE service = ?
        AND run_key = ?
        AND started_at = ?
    `).get(
      service,
      marker.runKey,
      marker.startedAt,
    ) as RunRow | undefined;

    if (existing) {
      return existing;
    }

    const result = this.db.prepare(`
      INSERT INTO container_runs (
        service, run_key, started_at, observed_at
      )
      VALUES (?, ?, ?, ?)
    `).run(
      service,
      marker.runKey,
      marker.startedAt,
      new Date().toISOString(),
    );

    return this.getRunById(Number(result.lastInsertRowid), service);
  }

  private getRunById(runId: number, service: MetricsServiceName): RunRow | null {
    return this.db.prepare(`
      SELECT *
      FROM container_runs
      WHERE id = ? AND service = ?
    `).get(runId, service) as RunRow | undefined ?? null;
  }

  private getRunIds(service: MetricsServiceName): number[] {
    const rows = this.db.prepare(`
      SELECT id
      FROM container_runs
      WHERE service = ?
      ORDER BY started_at, id
    `).all(service) as Array<{ id: number }>;

    return rows.map((row) => row.id);
  }

  private readRunMarker(service: MetricsServiceName): RunMarker | null {
    const markerPath = path.join(this.runStateDir, `${service}.json`);

    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as unknown;
      return parseRunMarker(service, marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Unable to read ${service} run marker ${markerPath}: ${formatError(error)}`);
      }
      return null;
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS container_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL CHECK (service IN ('searxng', 'crawl4ai')),
        run_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (service, run_key, started_at)
      );

      CREATE TABLE IF NOT EXISTS searxng_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES container_runs(id) ON DELETE CASCADE,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        engine TEXT NOT NULL,
        query_hash TEXT,
        reason TEXT,
        cooldown_until TEXT,
        result_count INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_searxng_events_run_type_engine
        ON searxng_events(run_id, event_type, engine);

      CREATE INDEX IF NOT EXISTS idx_searxng_events_cooling
        ON searxng_events(run_id, engine, occurred_at, id);

      CREATE TABLE IF NOT EXISTS crawl4ai_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES container_runs(id) ON DELETE CASCADE,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        url_hash TEXT NOT NULL,
        status_code INTEGER,
        error TEXT,
        returned_bytes INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_crawl4ai_events_run_type
        ON crawl4ai_events(run_id, event_type);
    `);
  }
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getMetricsDataDir(): string {
  return process.env.MCP_METRICS_DATA_DIR || './data';
}

function getMetricsDbPath(): string {
  return process.env.MCP_METRICS_DB_PATH || path.join(getMetricsDataDir(), 'mcp-metrics.sqlite3');
}

function getRunStateDir(): string {
  return process.env.MCP_RUN_STATE_DIR || path.join(getMetricsDataDir(), 'container-runs');
}

function parseRunMarker(service: MetricsServiceName, marker: unknown): RunMarker {
  if (!marker || typeof marker !== 'object') {
    throw new Error('Run marker must be a JSON object');
  }

  const record = marker as Record<string, unknown>;
  const markerService = record.service;
  const runKey = record.run_id ?? record.run_key;
  const startedAt = record.started_at;

  if (markerService !== service) {
    throw new Error(`Run marker service must be ${service}`);
  }
  if (typeof runKey !== 'string' || runKey.trim() === '') {
    throw new Error('Run marker missing run_id');
  }
  if (typeof startedAt !== 'string' || startedAt.trim() === '') {
    throw new Error('Run marker missing started_at');
  }

  return {
    service,
    runKey,
    startedAt,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentage(successes: number, attempts: number): number {
  return attempts > 0 ? round((successes / attempts) * 100) : 0;
}

function bytesToMb(bytes: number): number {
  return round(bytes / 1024 / 1024);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function serializeRun(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    service: run.service,
    run_key: run.run_key,
    started_at: run.started_at,
    observed_at: run.observed_at,
  };
}

async function safeEnabledEngines(getSearxngEnabledEngines: () => Promise<string[]>): Promise<string[]> {
  try {
    return await getSearxngEnabledEngines();
  } catch (error) {
    logger.warn('Unable to fetch SearXNG enabled engines for metrics: %s', error instanceof Error ? error.message : String(error));
    return [];
  }
}
