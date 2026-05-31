import {
  GatewayTimeoutException,
  GoneException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobResponseDto, ResultStoreService } from '@app/shared';
import { JobManagerClient } from '../job-manager-client/job-manager-client.service';
import { JobEventsService } from '../events/job-events.service';

export interface ScrapeAcceptedResponse {
  jobId: string;
  status: 'pending';
}

export interface ScrapeCompletedResponse {
  jobId: string;
  status: 'completed';
  html: string;
}

// Derived from the JM DTO so id/status/attempts stay in lockstep with the
// domain type; html/error are re-declared because they go nullable → optional.
export type ScrapeStatusResponse = Pick<JobResponseDto, 'id' | 'status' | 'attempts'> & {
  html?: string;
  error?: string;
};

@Injectable()
export class ScrapeService {
  private readonly waitTimeoutMs: number;

  constructor(
    private readonly jm: JobManagerClient,
    private readonly events: JobEventsService,
    private readonly results: ResultStoreService,
    config: ConfigService,
  ) {
    this.waitTimeoutMs = parseInt(config.get<string>('SCRAPE_WAIT_TIMEOUT_MS', '30000'), 10);
  }

  async submit(
    url: string,
    wait: boolean,
  ): Promise<ScrapeAcceptedResponse | ScrapeCompletedResponse> {
    const created = await this.jm.createJob(url);

    if (!wait) {
      return { jobId: created.id, status: 'pending' };
    }

    // Race-safe wait: register the listener BEFORE checking the DB,
    // so we don't miss a publish that fires between check and subscribe.
    const eventPromise = this.events.waitFor(created.id, this.waitTimeoutMs);

    let current = await this.jm.getJob(created.id);
    if (current.status === 'pending' || current.status === 'in_progress') {
      await eventPromise;
      current = await this.jm.getJob(created.id);
    }

    if (current.status === 'completed') {
      const html = await this.results.get(current.id);
      if (html !== null) {
        return { jobId: current.id, status: 'completed', html };
      }
      // Metadata says completed but the cached body is gone — only possible if
      // the result TTL elapsed before this (just-submitted) request read it.
      throw new GoneException(`Result for job ${current.id} has expired`);
    }
    if (current.status === 'failed') {
      throw new ServiceUnavailableException(current.error ?? 'Scrape failed');
    }
    throw new GatewayTimeoutException(
      `Job ${created.id} did not complete within ${this.waitTimeoutMs}ms`,
    );
  }

  async getStatus(id: string): Promise<ScrapeStatusResponse> {
    const job = await this.jm.getJob(id);
    // Only hit the result cache when there's something to fetch; an expired
    // TTL simply yields `undefined` html on an otherwise-completed job.
    const html = job.status === 'completed' ? await this.results.get(id) : null;
    return {
      id: job.id,
      status: job.status,
      html: html ?? undefined,
      error: job.error ?? undefined,
      attempts: job.attempts,
    };
  }
}
