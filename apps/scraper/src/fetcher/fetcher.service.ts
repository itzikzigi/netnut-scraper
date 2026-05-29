import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig } from 'axios';

@Injectable()
export class FetcherService {
  private readonly logger = new Logger(FetcherService.name);
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(config: ConfigService) {
    this.timeoutMs = parseInt(config.get<string>('FETCH_TIMEOUT_MS', '20000'), 10);
    this.userAgent = config.get<string>('FETCH_USER_AGENT', 'NetnutScraperBot/0.1');
  }

  async fetch(url: string): Promise<string> {
    const config: AxiosRequestConfig = {
      timeout: this.timeoutMs,
      responseType: 'text',
      maxRedirects: 5,
      transformResponse: (data) => data,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: { 'User-Agent': this.userAgent },
    };

    const response = await axios.get<string>(url, config);
    return response.data;
  }
}
