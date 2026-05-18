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
  unresponsive_engines: string[];
}

export class SearXNGClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async search(
    query: string, 
    options: {
      categories?: string;
      engines?: string;
      language?: string;
      pageno?: number;
      time_range?: string;
      format?: 'html' | 'json';
      safesearch?: 0 | 1 | 2;
    } = {}
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
