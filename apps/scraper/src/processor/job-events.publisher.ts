import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { JOB_COMPLETED_CHANNEL } from '@app/shared';

@Injectable()
export class JobEventsPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobEventsPublisher.name);
  private publisher!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.publisher = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: parseInt(this.config.get<string>('REDIS_PORT', '6379'), 10),
    });
  }

  async onModuleDestroy() {
    await this.publisher?.quit();
  }

  async publishDone(jobId: string): Promise<void> {
    const channel = JOB_COMPLETED_CHANNEL(jobId);
    await this.publisher.publish(channel, '1');
    this.logger.debug(`Published ${channel}`);
  }
}
