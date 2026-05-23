import axios, { AxiosError, type AxiosResponse } from 'axios';
import { logger } from './logger.js';
import type { MetricsRecorder } from './metrics.js';

const DEFAULT_SCRAPE_TIMEOUT_MS = 10000;
const DEFAULT_BATCH_TIMEOUT_MS = 45000;

export interface ScrapeOptions {
  formats?: string[];
  wait_for?: number;
  timeout?: number;
  proxy_url?: string;
}

export interface BatchScrapeOptions {
  formats?: string[];
  concurrency?: number;
  timeout?: number;
}

export interface ExtractOptions {
  prompt: string;
  schema?: any;
}

export interface Crawl4AIResponse {
  success: boolean;
  url: string;
  data?: {
    markdown?: string;
    html?: string;
    links?: string[];
    media?: string[];
    metadata?: {
      title: string;
      description: string;
      language: string;
      word_count: number;
    };
  };
  error?: string;
  status?: number;
}

export interface BatchScrapeResponse {
  success: boolean;
  total: number;
  results: Crawl4AIResponse[];
}

export class Crawl4AIClient {
  private baseUrl: string;
  private metrics?: MetricsRecorder;

  constructor(baseUrl: string = 'http://localhost:8000', metrics?: MetricsRecorder) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.metrics = metrics;
  }

  async scrape(url: string, options: ScrapeOptions = {}): Promise<Crawl4AIResponse> {
    this.recordMetric({
      eventType: 'scrape_attempted',
      url,
    });

    try {
      logger.info(`Scraping with Crawl4AI: ${url}`);
      
      const response: AxiosResponse<Crawl4AIResponse> = await axios.post(
        `${this.baseUrl}/scrape`,
        {
          url,
          formats: options.formats || ['markdown'],
          wait_for: options.wait_for || 0,
          timeout: options.timeout || DEFAULT_SCRAPE_TIMEOUT_MS,
          proxy_url: options.proxy_url
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: (options.timeout || DEFAULT_SCRAPE_TIMEOUT_MS) + 5000
        }
      );

      const result = response.data;
      
      if (!result.success) {
        logger.warn(`Crawl4AI scrape failed for ${url}: ${result.error || 'Unknown error'}`);
        this.recordMetric({
          eventType: 'scrape_failed',
          url,
          statusCode: result.status,
          error: result.error || 'Unknown error',
        });
        return result;
      }
      
      logger.info(`Successfully scraped ${url} (${result.data?.metadata?.word_count || 0} words)`);
      this.recordMetric({
        eventType: 'scrape_succeeded',
        url: result.url || url,
        statusCode: result.status,
        returnedBytes: this.calculateReturnedBytes(result),
      });
      return result;
      
    } catch (error) {
      logger.error(`Crawl4AI scrape error for ${url}:`, error);
      if (error instanceof AxiosError) {
        if (this.isBackendUnavailableError(error)) {
          throw new Error(this.formatAxiosError(error));
        }
        const scrapeFailure: Crawl4AIResponse = {
          success: false,
          url,
          error: this.formatAxiosError(error),
        };
        if (error.response?.status) {
          scrapeFailure.status = error.response.status;
        }
        this.recordMetric({
          eventType: 'scrape_failed',
          url,
          statusCode: scrapeFailure.status,
          error: scrapeFailure.error,
        });
        return scrapeFailure;
      }
      this.recordMetric({
        eventType: 'scrape_failed',
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async batchScrape(urls: string[], options: BatchScrapeOptions = {}): Promise<BatchScrapeResponse> {
    urls.forEach((url) => {
      this.recordMetric({
        eventType: 'scrape_attempted',
        url,
      });
    });

    try {
      logger.info(`Batch scraping ${urls.length} URLs with Crawl4AI`);
      
      const response: AxiosResponse<BatchScrapeResponse> = await axios.post(
        `${this.baseUrl}/batch-scrape`,
        {
          urls,
          formats: options.formats || ['markdown'],
          concurrency: Math.min(options.concurrency || 3, 5),
          timeout: options.timeout
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: (options.timeout || DEFAULT_BATCH_TIMEOUT_MS) + 5000
        }
      );

      const result = response.data;
      
      const successful = result.results.filter(r => r.success).length;
      logger.info(`Batch scrape completed: ${successful}/${result.total} successful`);
      result.results.forEach((scrapeResult) => {
        if (scrapeResult.success) {
          this.recordMetric({
            eventType: 'scrape_succeeded',
            url: scrapeResult.url,
            statusCode: scrapeResult.status,
            returnedBytes: this.calculateReturnedBytes(scrapeResult),
          });
          return;
        }

        this.recordMetric({
          eventType: 'scrape_failed',
          url: scrapeResult.url,
          statusCode: scrapeResult.status,
          error: scrapeResult.error || 'Unknown error',
        });
      });
      
      return result;
      
    } catch (error) {
      logger.error('Crawl4AI batch scrape error:', error);
      urls.forEach((url) => {
        this.recordMetric({
          eventType: 'scrape_failed',
          url,
          error: error instanceof Error ? this.formatError(error) : 'Unknown error',
        });
      });
      if (error instanceof AxiosError) {
        throw new Error(this.formatAxiosError(error));
      }
      throw error;
    }
  }

  async extract(url: string, options: ExtractOptions): Promise<Crawl4AIResponse> {
    try {
      logger.info(`Extracting data from ${url} with prompt: "${options.prompt.substring(0, 50)}..."`);
      
      const response: AxiosResponse<Crawl4AIResponse> = await axios.post(
        `${this.baseUrl}/extract`,
        {
          url,
          prompt: options.prompt,
          schema: options.schema
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 60000 // Extraction can take longer
        }
      );

      const result = response.data;
      
      if (!result.success) {
        throw new Error(`Extraction failed: ${result.error}`);
      }
      
      logger.info(`Successfully extracted data from ${url}`);
      return result;
      
    } catch (error) {
      logger.error(`Crawl4AI extract error for ${url}:`, error);
      if (error instanceof AxiosError) {
        throw new Error(this.formatAxiosError(error));
      }
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  private formatAxiosError(error: AxiosError): string {
    const status = error.response?.status;
    const data = error.response?.data;
    const detail = this.extractErrorDetail(data);

    if (status && detail) {
      return `Request failed with status code ${status}: ${detail}`;
    }
    if (status) {
      return `Request failed with status code ${status}`;
    }
    return error.message;
  }

  private isBackendUnavailableError(error: AxiosError): boolean {
    if (error.response) {
      return false;
    }

    return [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNRESET',
    ].includes(error.code || '');
  }

  private extractErrorDetail(data: unknown): string | undefined {
    if (!data) {
      return undefined;
    }
    if (typeof data === 'string') {
      return data;
    }
    if (typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail?: unknown }).detail;
      if (typeof detail === 'string') {
        return detail;
      }
      if (detail) {
        return JSON.stringify(detail);
      }
    }
    return JSON.stringify(data);
  }

  private calculateReturnedBytes(result: Crawl4AIResponse): number {
    return Buffer.byteLength(JSON.stringify(result.data ?? {}), 'utf8');
  }

  private formatError(error: Error): string {
    if (error instanceof AxiosError) {
      return this.formatAxiosError(error);
    }
    return error.message;
  }

  private recordMetric(event: Parameters<MetricsRecorder['recordCrawl4AIEvent']>[0]): void {
    if (!this.metrics) {
      return;
    }

    void this.metrics.recordCrawl4AIEvent(event);
  }
}
