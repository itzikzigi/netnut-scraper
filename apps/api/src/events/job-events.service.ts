import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class JobEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobEventsService.name);
  private subscriber!: Redis;
  private readonly waiters = new Map<string, () => void>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.subscriber = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: parseInt(this.config.get<string>('REDIS_PORT', '6379'), 10),
      lazyConnect: false,
    });

    this.subscriber.on('pmessage', (_pattern, channel) => {
      const match = channel.match(/^job:(.+):done$/);
      if (!match) return;
      const resolve = this.waiters.get(match[1]);
      if (resolve) resolve();
    });

    await this.subscriber.psubscribe('job:*:done');
    this.logger.log('Subscribed to job:*:done');
  }

  async onModuleDestroy() {
    await this.subscriber?.quit();
  }

  /**
   * Resolves when `job:<jobId>:done` is published, or after `timeoutMs`.
   * Always resolves — caller must re-check DB to determine final state.
   * Register the waiter BEFORE checking the DB to avoid pub/check races.
   */
  waitFor(jobId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(jobId);
        resolve();
      }, timeoutMs);

      this.waiters.set(jobId, () => {
        clearTimeout(timer);
        this.waiters.delete(jobId);
        resolve();
      });
    });
  }
}
