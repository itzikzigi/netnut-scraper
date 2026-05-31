import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { UrlSafetyService } from './url-safety.service';

@Injectable()
export class FetcherService {
  private readonly logger = new Logger(FetcherService.name);
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly maxBytes: number;

  constructor(
    config: ConfigService,
    private readonly urlSafety: UrlSafetyService,
  ) {
    this.timeoutMs = parseInt(config.get<string>('FETCH_TIMEOUT_MS', '20000'), 10);
    this.userAgent = config.get<string>('FETCH_USER_AGENT', 'NetnutScraperBot/0.1');
    // Cap the response body so a huge/hostile page can't exhaust memory or
    // bloat Redis. Buffered fully into a string, so this is a hard ceiling.
    this.maxBytes = parseInt(config.get<string>('FETCH_MAX_BYTES', '5000000'), 10);
  }

  async fetch(url: string, proxyUrl: string | null = null): Promise<string> {
    // SSRF pre-flight: reject bad protocols / private targets before connecting.
    await this.urlSafety.assertPublicUrl(url);

    const config: AxiosRequestConfig = {
      timeout: this.timeoutMs,
      responseType: 'text',
      maxRedirects: 5,
      maxContentLength: this.maxBytes,
      maxBodyLength: this.maxBytes,
      transformResponse: (data) => data,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: { 'User-Agent': this.userAgent },
      proxy: false,
    };

    if (proxyUrl) {
      // Both agents set so we tunnel correctly regardless of target scheme.
      // The proxy resolves the target, so SSRF egress control is the proxy's
      // responsibility here — the connect-time lookup guard can't apply.
      config.httpsAgent = new HttpsProxyAgent(proxyUrl);
      config.httpAgent = new HttpProxyAgent(proxyUrl);
    } else {
      // Direct path: validate every connection (initial + each redirect) against
      // the resolved IP, which also defeats DNS rebinding past the pre-flight.
      const lookup = this.urlSafety.guardedLookup();
      config.httpAgent = new HttpAgent({ lookup });
      config.httpsAgent = new HttpsAgent({ lookup });
    }

    const response = await axios.get<string>(url, config);
    return response.data;
  }
}
