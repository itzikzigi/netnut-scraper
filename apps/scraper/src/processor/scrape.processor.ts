import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { JobsService, ResultStoreService, SCRAPE_QUEUE_NAME, ScrapeJobPayload } from '@app/shared';
import { FetcherService } from '../fetcher/fetcher.service';
import { ProxyPoolService } from '../fetcher/proxy-pool.service';
import { BlockedUrlError } from '../fetcher/url-safety.service';
import { JobEventsPublisher } from './job-events.publisher';

// Scraping is network-bound (each fetch waits on a ~20s timeout), so a single
// in-flight job per worker wastes the pod. Process several concurrently;
// override via SCRAPER_CONCURRENCY. Read from process.env here because the
// @Processor decorator is evaluated at class-definition time, before DI.
const CONCURRENCY = parseInt(process.env.SCRAPER_CONCURRENCY ?? '10', 10);

@Processor(SCRAPE_QUEUE_NAME, { concurrency: CONCURRENCY })
export class ScrapeProcessor extends WorkerHost {
  private readonly logger = new Logger(ScrapeProcessor.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly proxyPool: ProxyPoolService,
    private readonly jobs: JobsService,
    private readonly results: ResultStoreService,
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
      // A blocked/malformed URL is deterministic — retrying can't help, so fail
      // it now and tell BullMQ not to retry.
      const unrecoverable = err instanceof BlockedUrlError;
      this.logger.warn(
        `Fetch failed for ${jobId} (${attempt}/${maxAttempts})${unrecoverable ? ' [unrecoverable]' : ''}: ${message}`,
      );
      if (unrecoverable || attempt >= maxAttempts) {
        await this.jobs.markFailed(jobId, message);
        await this.safePublish(jobId);
      }
      if (unrecoverable) throw new UnrecoverableError(message);
      throw err;
    }

    // Cache the body in Redis BEFORE flipping status / publishing, so any
    // reader that observes 'completed' (via DB or the done event) is
    // guaranteed to find the HTML already present.
    await this.results.store(jobId, html);
    await this.jobs.markCompleted(jobId);
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
