import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { JobsService, SCRAPE_QUEUE_NAME, ScrapeJobPayload } from '@app/shared';
import { FetcherService } from '../fetcher/fetcher.service';
import { ProxyPoolService } from '../fetcher/proxy-pool.service';
import { JobEventsPublisher } from './job-events.publisher';

@Processor(SCRAPE_QUEUE_NAME)
export class ScrapeProcessor extends WorkerHost {
  private readonly logger = new Logger(ScrapeProcessor.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly proxyPool: ProxyPoolService,
    private readonly jobs: JobsService,
    private readonly publisher: JobEventsPublisher,
  ) {
    super();
  }

  async process(job: Job<ScrapeJobPayload>): Promise<void> {
    const { jobId, url } = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    // Pick a proxy per attempt — retries naturally rotate.
    const proxy = this.proxyPool.next();
    const proxyLabel = proxy ? this.proxyPool.describe(proxy) : null;

    this.logger.log(
      `Processing ${jobId} → ${url} (attempt ${attempt}/${maxAttempts}) via ${proxyLabel ?? 'direct'}`,
    );

    await this.jobs.markInProgress(jobId, proxyLabel);

    let html: string;
    try {
      html = await this.fetcher.fetch(url, proxy);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Fetch failed for ${jobId} (${attempt}/${maxAttempts}): ${message}`);
      if (attempt >= maxAttempts) {
        await this.jobs.markFailed(jobId, message);
        await this.safePublish(jobId);
      }
      throw err;
    }

    await this.jobs.markCompleted(jobId, html);
    await this.safePublish(jobId);
    this.logger.log(`Completed ${jobId} (${html.length} bytes)`);
  }

  private async safePublish(jobId: string): Promise<void> {
    try {
      await this.publisher.publishDone(jobId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Publish failed for ${jobId}: ${message}`);
    }
  }
}
