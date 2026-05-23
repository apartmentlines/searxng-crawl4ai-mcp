import axios, { type AxiosError, type AxiosResponse } from 'axios';
import { logger } from './logger.js';
import type { MetricsRecorder } from './metrics.js';

const SEARCH_INTERVAL_MIN_MS = 5000;
const SEARCH_INTERVAL_MAX_MS = 10000;

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  img_src?: string;
  category?: string;
  score?: number;
}

export interface SearXNGSearchResponse {
  query: string;
  number_of_results: number;
  results: SearchResult[];
  answers: string[];
  corrections: string[];
  infoboxes: any[];
  suggestions: string[];
  unresponsive_engines: [string, string][];
}

interface SearXNGEngineConfig {
  name: string;
  enabled: boolean;
}

interface SearXNGConfigResponse {
  engines: SearXNGEngineConfig[];
}

interface EngineAttemptFailure {
  engine: string;
  reason: string;
  retry_after_ms?: number;
}

export interface SearXNGFallbackSearchResponse extends SearXNGSearchResponse {
  success: boolean;
  engine_used: string | null;
  failed_engines: EngineAttemptFailure[];
  message?: string;
}

export interface SearXNGSearchOptions {
  categories?: string;
  engines?: string;
  language?: string;
  pageno?: number;
  time_range?: string;
  format?: 'html' | 'json';
  safesearch?: 0 | 1 | 2;
}

export class SearXNGClient {
  private baseUrl: string;
  private metrics?: MetricsRecorder;
  private lastSearchAt = 0;
  private searchIntervalMinMs: number;
  private searchIntervalMaxMs: number;
  private engineCooldownMs: number;
  private engineCooldownUntil = new Map<string, number>();
  private searchQueue: Promise<void> = Promise.resolve();
  private engineCursor = 0;

  constructor(baseUrl: string = 'http://localhost:8080', metrics?: MetricsRecorder) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.metrics = metrics;
    this.searchIntervalMinMs = this.parseNonNegativeIntegerEnv('SEARXNG_SEARCH_INTERVAL_MIN_MS', SEARCH_INTERVAL_MIN_MS);
    this.searchIntervalMaxMs = this.parseNonNegativeIntegerEnv('SEARXNG_SEARCH_INTERVAL_MAX_MS', SEARCH_INTERVAL_MAX_MS);
    this.engineCooldownMs = Number.parseInt(process.env.SEARXNG_ENGINE_COOLDOWN_MS || '1800000', 10);

    if (this.searchIntervalMinMs > this.searchIntervalMaxMs) {
      this.searchIntervalMinMs = SEARCH_INTERVAL_MIN_MS;
      this.searchIntervalMaxMs = SEARCH_INTERVAL_MAX_MS;
    }

    if (!Number.isFinite(this.engineCooldownMs) || this.engineCooldownMs < 0) {
      this.engineCooldownMs = 1800000;
    }
  }

  async search(
    query: string, 
    options: SearXNGSearchOptions = {}
  ): Promise<SearXNGSearchResponse> {
    return this.runThrottledSearch(async () => {
      return await this.executeSearch(query, options);
    });
  }

  async searchWithEngineFallback(
    query: string,
    options: SearXNGSearchOptions = {}
  ): Promise<SearXNGFallbackSearchResponse> {
    const engines = await this.resolveCandidateEngines(options.engines);
    const orderedEngines = this.rotateEngines(engines);
    const failedEngines: EngineAttemptFailure[] = [];

    for (const engine of orderedEngines) {
      const cooldownRemainingMs = this.getEngineCooldownRemainingMs(engine);
      if (cooldownRemainingMs > 0) {
        const reason = `Cooling down after CAPTCHA/rate-limit failure`;
        const cooldownUntil = this.engineCooldownUntil.get(engine);
        this.recordMetric({
          eventType: 'engine_cooldown_skipped',
          engine,
          query,
          reason,
          cooldownUntil: cooldownUntil ? new Date(cooldownUntil) : undefined,
        });
        failedEngines.push({ engine, reason, retry_after_ms: cooldownRemainingMs });
        logger.warn(`SearXNG engine ${engine} skipped for "${query}": ${reason} (${cooldownRemainingMs}ms remaining)`);
        await this.waitForSearchInterval();
        continue;
      }

      try {
        this.recordMetric({
          eventType: 'engine_attempted',
          engine,
          query,
        });
        const result = await this.search(query, {
          ...options,
          engines: engine,
        });
        const failureReason = this.getSearchFailureReason(result, engine);

        if (failureReason) {
          this.recordMetric({
            eventType: 'engine_failed',
            engine,
            query,
            reason: failureReason,
            resultCount: this.countReturnedResults(result),
          });
          failedEngines.push({ engine, reason: failureReason });
          logger.warn(`SearXNG engine ${engine} failed for "${query}": ${failureReason}`);
          const cooldownUntil = this.cooldownEngineIfNeeded(engine, failureReason);
          if (cooldownUntil) {
            this.recordMetric({
              eventType: 'engine_cooldown_started',
              engine,
              query,
              reason: failureReason,
              cooldownUntil,
            });
          }
          continue;
        }

        this.clearEngineCooldown(engine, query);
        this.recordMetric({
          eventType: 'engine_succeeded',
          engine,
          query,
          resultCount: this.countReturnedResults(result),
        });
        logger.info(`SearXNG engine ${engine} succeeded for "${query}"`);
        return {
          ...result,
          success: true,
          engine_used: engine,
          failed_engines: failedEngines,
        };
      } catch (error) {
        if (this.isBackendUnavailableError(error)) {
          throw error;
        }

        const reason = error instanceof Error ? error.message : 'Unknown error';
        this.recordMetric({
          eventType: 'engine_failed',
          engine,
          query,
          reason,
        });
        failedEngines.push({ engine, reason });
        logger.warn(`SearXNG engine ${engine} failed for "${query}": ${reason}`);
        const cooldownUntil = this.cooldownEngineIfNeeded(engine, reason);
        if (cooldownUntil) {
          this.recordMetric({
            eventType: 'engine_cooldown_started',
            engine,
            query,
            reason,
            cooldownUntil,
          });
        }
      }
    }

    return this.createFailedSearchResponse(query, failedEngines);
  }

  async getActiveEngines(): Promise<string[]> {
    try {
      const response: AxiosResponse<SearXNGConfigResponse> = await axios.get(`${this.baseUrl}/config`, {
        headers: {
          'Accept': 'application/json'
        },
        timeout: 5000
      });

      return response.data.engines
        .filter((engine) => engine.enabled)
        .map((engine) => engine.name);
    } catch (error) {
      logger.error('Failed to get active SearXNG engines:', error);
      return [];
    }
  }

  private async executeSearch(
    query: string,
    options: SearXNGSearchOptions = {}
  ): Promise<SearXNGSearchResponse> {
    const searchParams = new URLSearchParams({
      q: query,
      format: options.format || 'json',
      ...options.categories && { categories: options.categories },
      ...options.engines && { engines: options.engines },
      ...options.language && { language: options.language },
      ...options.pageno && { pageno: options.pageno.toString() },
      ...options.time_range && { time_range: options.time_range },
      ...options.safesearch !== undefined && { safesearch: options.safesearch.toString() },
    });

    const url = `${this.baseUrl}/search?${searchParams}`;
      
    try {
      logger.info(`Searching SearXNG: ${query}`);
        
      const response: AxiosResponse<SearXNGSearchResponse> = await axios.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Firecrawl-MCP-Custom/1.0'
        },
        timeout: 10000
      });

      const data = response.data;
        
      logger.info(`SearXNG found ${data.number_of_results} results`);
      return data;
        
    } catch (error) {
      logger.error(`SearXNG search error for "${query}":`, error);
      throw error;
    }
  }

  private async resolveCandidateEngines(engineOverride?: string): Promise<string[]> {
    const engines = engineOverride
      ? engineOverride.split(',').map((engine) => engine.trim()).filter(Boolean)
      : await this.getActiveEngines();

    return [...new Set(engines)];
  }

  private rotateEngines(engines: string[]): string[] {
    if (engines.length === 0) {
      throw new Error('No active SearXNG engines found');
    }

    const startIndex = this.engineCursor % engines.length;
    this.engineCursor = (this.engineCursor + 1) % engines.length;

    return [
      ...engines.slice(startIndex),
      ...engines.slice(0, startIndex),
    ];
  }

  private getSearchFailureReason(result: SearXNGSearchResponse, engine: string): string | null {
    const unresponsiveEntry = result.unresponsive_engines?.find(([name]) => name === engine);

    if (unresponsiveEntry) {
      const reason = unresponsiveEntry[1] || 'Unresponsive';
      const normalizedReason = reason.toLowerCase();

      if (
        normalizedReason.includes('captcha') ||
        normalizedReason.includes('429') ||
        normalizedReason.includes('too many') ||
        normalizedReason.includes('access denied') ||
        normalizedReason.includes('suspended')
      ) {
        return reason;
      }
    }

    if (!result.results || result.results.length === 0) {
      return unresponsiveEntry?.[1] || 'No results';
    }

    return null;
  }

  private countReturnedResults(result: SearXNGSearchResponse): number {
    return Array.isArray(result.results) ? result.results.length : 0;
  }

  private createFailedSearchResponse(
    query: string,
    failedEngines: EngineAttemptFailure[]
  ): SearXNGFallbackSearchResponse {
    return {
      success: false,
      query,
      number_of_results: 0,
      results: [],
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsive_engines: [],
      engine_used: null,
      failed_engines: failedEngines,
      message: 'No search results found',
    };
  }

  private isBackendUnavailableError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    const axiosError = error as AxiosError;

    if (axiosError.response) {
      return false;
    }

    return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(axiosError.code || '');
  }

  private cooldownEngineIfNeeded(engine: string, reason: string): Date | null {
    if (this.engineCooldownMs === 0 || !this.isCooldownFailureReason(reason)) {
      return null;
    }

    const cooldownUntil = Date.now() + this.engineCooldownMs;
    this.engineCooldownUntil.set(engine, cooldownUntil);
    logger.warn(`SearXNG engine ${engine} cooling down for ${this.engineCooldownMs}ms after: ${reason}`);
    return new Date(cooldownUntil);
  }

  private clearEngineCooldown(engine: string, query?: string): void {
    if (this.engineCooldownUntil.has(engine)) {
      this.recordMetric({
        eventType: 'engine_cooldown_cleared',
        engine,
        query,
      });
    }
    this.engineCooldownUntil.delete(engine);
  }

  private getEngineCooldownRemainingMs(engine: string): number {
    const cooldownUntil = this.engineCooldownUntil.get(engine);

    if (!cooldownUntil) {
      return 0;
    }

    const remainingMs = cooldownUntil - Date.now();

    if (remainingMs <= 0) {
      this.engineCooldownUntil.delete(engine);
      return 0;
    }

    return remainingMs;
  }

  private isCooldownFailureReason(reason: string): boolean {
    const normalizedReason = reason.toLowerCase();

    return (
      normalizedReason.includes('captcha') ||
      normalizedReason.includes('429') ||
      normalizedReason.includes('too many') ||
      normalizedReason.includes('access denied') ||
      normalizedReason.includes('rate limit') ||
      normalizedReason.includes('ratelimit') ||
      normalizedReason.includes('suspended')
    );
  }

  private parseNonNegativeIntegerEnv(name: string, fallback: number): number {
    const rawValue = process.env[name];

    if (!rawValue) {
      return fallback;
    }

    const parsedValue = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
  }

  private getSearchIntervalDelayMs(): number {
    const range = this.searchIntervalMaxMs - this.searchIntervalMinMs;
    return this.searchIntervalMinMs + Math.floor(Math.random() * (range + 1));
  }

  private async runThrottledSearch<T>(operation: () => Promise<T>): Promise<T> {
    const previousSearch = this.searchQueue.catch(() => undefined);
    let releaseSearch!: () => void;

    this.searchQueue = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });

    await previousSearch;

    try {
      const elapsed = Date.now() - this.lastSearchAt;
      const delay = this.getSearchIntervalDelayMs() - elapsed;

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      this.lastSearchAt = Date.now();
      return await operation();
    } finally {
      releaseSearch();
    }
  }

  private async waitForSearchInterval(): Promise<void> {
    await this.runThrottledSearch(async () => undefined);
  }

  async getEngines(): Promise<any> {
    try {
      const response = await axios.get(`${this.baseUrl}/stats`, {
        headers: {
          'Accept': 'application/json'
        }
      });
      
      return response.data;
    } catch (error) {
      logger.error('Failed to get SearXNG engines:', error);
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/healthz`, {
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  private recordMetric(event: Parameters<MetricsRecorder['recordSearxngEvent']>[0]): void {
    if (!this.metrics) {
      return;
    }

    void this.metrics.recordSearxngEvent(event);
  }
}
