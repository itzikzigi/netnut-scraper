export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ScrapeJob {
  id: string;
  url: string;
  status: JobStatus;
  // Scraped HTML is NOT persisted here — it lives in Redis with a TTL
  // (see ResultStoreService). This entity/contract holds durable metadata only.
  error: string | null;
  attempts: number;
  proxyUsed: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScrapeJobPayload {
  jobId: string;
  url: string;
}

export type JobResponseDto = Omit<ScrapeJob, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};
