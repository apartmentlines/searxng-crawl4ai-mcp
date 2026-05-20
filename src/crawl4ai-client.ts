import axios, { AxiosError, type AxiosResponse } from 'axios';
import { logger } from './logger.js';

export interface ScrapeOptions {
  formats?: string[];
  wait_for?: number;
  timeout?: number;
  proxy_url?: string;
}

export interface BatchScrapeOptions {
  formats?: string[];
  concurrency?: number;
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
}

export interface BatchScrapeResponse {
  success: boolean;
  total: number;
  results: Crawl4AIResponse[];
}

export class Crawl4AIClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async scrape(url: string, options: ScrapeOptions = {}): Promise<Crawl4AIResponse> {
    try {
      logger.info(`Scraping with Crawl4AI: ${url}`);
      
      const response: AxiosResponse<Crawl4AIResponse> = await axios.post(
        `${this.baseUrl}/scrape`,
        {
          url,
          formats: options.formats || ['markdown'],
          wait_for: options.wait_for || 0,
          timeout: options.timeout || 30000,
          proxy_url: options.proxy_url
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: (options.timeout || 30000) + 5000
        }
      );

      const result = response.data;
      
      if (!result.success) {
        throw new Error(`Scraping failed: ${result.error}`);
      }
      
      logger.info(`Successfully scraped ${url} (${result.data?.metadata?.word_count || 0} words)`);
      return result;
      
    } catch (error) {
      logger.error(`Crawl4AI scrape error for ${url}:`, error);
      if (error instanceof AxiosError) {
        throw new Error(this.formatAxiosError(error));
      }
      throw error;
    }
  }

  async batchScrape(urls: string[], options: BatchScrapeOptions = {}): Promise<BatchScrapeResponse> {
    try {
      logger.info(`Batch scraping ${urls.length} URLs with Crawl4AI`);
      
      const response: AxiosResponse<BatchScrapeResponse> = await axios.post(
        `${this.baseUrl}/batch-scrape`,
        {
          urls,
          formats: options.formats || ['markdown'],
          concurrency: Math.min(options.concurrency || 3, 5)
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 120000 // 2 minutes for batch operations
        }
      );

      const result = response.data;
      
      const successful = result.results.filter(r => r.success).length;
      logger.info(`Batch scrape completed: ${successful}/${result.total} successful`);
      
      return result;
      
    } catch (error) {
      logger.error('Crawl4AI batch scrape error:', error);
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
}
