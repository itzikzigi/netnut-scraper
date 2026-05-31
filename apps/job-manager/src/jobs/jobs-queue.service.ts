import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SCRAPE_QUEUE_NAME, ScrapeJobPayload } from '@app/shared';

@Injectable()
export class JobsQueueService {
  private readonly logger = new Logger(JobsQueueService.name);

  constructor(
    @InjectQueue(SCRAPE_QUEUE_NAME)
    private readonly queue: Queue<ScrapeJobPayload>,
  ) {}

  async enqueue(payload: ScrapeJobPayload): Promise<void> {
    await this.queue.add('scrape', payload, { jobId: payload.jobId });
    this.logger.log(`Enqueued ${payload.jobId} → ${payload.url}`);
  }
}
