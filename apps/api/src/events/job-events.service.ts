import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class JobEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobEventsService.name);
  private subscriber!: Redis;
  // Multiple `?wait=true` requests can await the same jobId concurrently, so
  // each id maps to a SET of resolvers — a single slot would let a later
  // waiter overwrite (and strand) an earlier one until its timeout fires.
  private readonly waiters = new Map<string, Set<() => void>>();

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
      const resolvers = this.waiters.get(match[1]);
      if (!resolvers) return;
      // Copy before iterating: each resolve() mutates the set via cleanup().
      for (const resolve of [...resolvers]) resolve();
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
      let waiter: () => void;

      const cleanup = () => {
        const set = this.waiters.get(jobId);
        if (!set) return;
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(jobId);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      waiter = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };

      let set = this.waiters.get(jobId);
      if (!set) {
        set = new Set();
        this.waiters.set(jobId, set);
      }
      set.add(waiter);
    });
  }
}
