import {
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobResponseDto } from '@app/shared';
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

export interface ScrapeStatusResponse {
  id: string;
  status: JobResponseDto['status'];
  html?: string;
  error?: string;
  attempts: number;
}

@Injectable()
export class ScrapeService {
  private readonly waitTimeoutMs: number;

  constructor(
    private readonly jm: JobManagerClient,
    private readonly events: JobEventsService,
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

    if (current.status === 'completed' && current.html !== null) {
      return { jobId: current.id, status: 'completed', html: current.html };
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
    return {
      id: job.id,
      status: job.status,
      html: job.html ?? undefined,
      error: job.error ?? undefined,
      attempts: job.attempts,
    };
  }
}
