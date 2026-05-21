import axios, { type AxiosResponse } from 'axios';
import { logger } from './logger.js';

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
}

export interface SearXNGFallbackSearchResponse extends SearXNGSearchResponse {
  engine_used: string;
  failed_engines: EngineAttemptFailure[];
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
  private lastSearchAt = 0;
  private minSearchIntervalMs: number;
  private searchQueue: Promise<void> = Promise.resolve();
  private engineCursor = 0;

  constructor(baseUrl: string = 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.minSearchIntervalMs = Number.parseInt(process.env.SEARXNG_MIN_SEARCH_INTERVAL_MS || '1000', 10);

    if (!Number.isFinite(this.minSearchIntervalMs) || this.minSearchIntervalMs < 0) {
      this.minSearchIntervalMs = 1000;
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
      try {
        const result = await this.search(query, {
          ...options,
          engines: engine,
        });
        const failureReason = this.getSearchFailureReason(result, engine);

        if (failureReason) {
          failedEngines.push({ engine, reason: failureReason });
          logger.warn(`SearXNG engine ${engine} failed for "${query}": ${failureReason}`);
          continue;
        }

        logger.info(`SearXNG engine ${engine} succeeded for "${query}"`);
        return {
          ...result,
          engine_used: engine,
          failed_engines: failedEngines,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        failedEngines.push({ engine, reason });
        logger.warn(`SearXNG engine ${engine} failed for "${query}": ${reason}`);
      }
    }

    throw new Error(`All SearXNG engines failed: ${failedEngines.map(({ engine, reason }) => `${engine}: ${reason}`).join('; ')}`);
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

  private async runThrottledSearch<T>(operation: () => Promise<T>): Promise<T> {
    const previousSearch = this.searchQueue.catch(() => undefined);
    let releaseSearch!: () => void;

    this.searchQueue = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });

    await previousSearch;

    try {
      const elapsed = Date.now() - this.lastSearchAt;
      const delay = this.minSearchIntervalMs - elapsed;

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      this.lastSearchAt = Date.now();
      return await operation();
    } finally {
      releaseSearch();
    }
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
}
