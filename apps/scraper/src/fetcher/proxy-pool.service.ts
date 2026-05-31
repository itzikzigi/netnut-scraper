import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ProxyPoolService {
  private readonly logger = new Logger(ProxyPoolService.name);
  private readonly pool: string[];
  private cursor = 0;

  constructor(config: ConfigService) {
    const raw = (config.get<string>('PROXY_POOL') ?? '').trim();
    this.pool = raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    if (this.pool.length === 0) {
      this.logger.log('PROXY_POOL empty — Scraper will fetch directly');
    } else {
      this.logger.log(`PROXY_POOL: ${this.pool.length} entries loaded`);
    }
  }

  isEmpty(): boolean {
    return this.pool.length === 0;
  }

  /** Returns next proxy URL in round-robin order, or null if pool is empty. */
  next(): string | null {
    if (this.pool.length === 0) return null;
    const proxy = this.pool[this.cursor % this.pool.length];
    this.cursor++;
    return proxy;
  }

  /** Strip credentials from a proxy URL so it's safe to log / store in DB. */
  describe(proxyUrl: string): string {
    try {
      const u = new URL(proxyUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return '<invalid>';
    }
  }
}
