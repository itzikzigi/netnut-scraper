import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

@Injectable()
export class FetcherService {
  private readonly logger = new Logger(FetcherService.name);
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(config: ConfigService) {
    this.timeoutMs = parseInt(config.get<string>('FETCH_TIMEOUT_MS', '20000'), 10);
    this.userAgent = config.get<string>('FETCH_USER_AGENT', 'NetnutScraperBot/0.1');
  }

  async fetch(url: string, proxyUrl: string | null = null): Promise<string> {
    const config: AxiosRequestConfig = {
      timeout: this.timeoutMs,
      responseType: 'text',
      maxRedirects: 5,
      transformResponse: (data) => data,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: { 'User-Agent': this.userAgent },
    };

    if (proxyUrl) {
      // Both agents set so we tunnel correctly regardless of target scheme.
      // axios `proxy: false` disables its built-in (unreliable) proxy handling
      // in favour of the agents.
      config.httpsAgent = new HttpsProxyAgent(proxyUrl);
      config.httpAgent = new HttpProxyAgent(proxyUrl);
      config.proxy = false;
    }

    const response = await axios.get<string>(url, config);
    return response.data;
  }
}
