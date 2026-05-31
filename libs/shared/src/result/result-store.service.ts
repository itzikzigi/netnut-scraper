import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { JOB_HTML_KEY } from '../constants';

/**
 * Stores scraped HTML in Redis with a TTL instead of Postgres. Results are
 * inherently transient, so they live in a cache that auto-evicts; Postgres
 * keeps only durable job metadata (status/error/attempts/timestamps).
 */
@Injectable()
export class ResultStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResultStoreService.name);
  private client!: Redis;
  private ttlSeconds!: number;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    // Separate connection from the Pub/Sub one: a subscriber connection can't
    // run GET/SET, so the result cache needs its own normal-mode client.
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: parseInt(this.config.get<string>('REDIS_PORT', '6379'), 10),
    });
    this.ttlSeconds = parseInt(this.config.get<string>('RESULT_TTL_SECONDS', '3600'), 10);
    this.logger.log(`Result cache TTL: ${this.ttlSeconds}s`);
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  /** Store scraped HTML under a per-job key that expires after the configured TTL. */
  async store(jobId: string, html: string): Promise<void> {
    await this.client.set(JOB_HTML_KEY(jobId), html, 'EX', this.ttlSeconds);
  }

  /** Return the cached HTML, or null if it was never stored or has expired. */
  get(jobId: string): Promise<string | null> {
    return this.client.get(JOB_HTML_KEY(jobId));
  }
}
