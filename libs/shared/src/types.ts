export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ScrapeJob {
  id: string;
  url: string;
  status: JobStatus;
  html: string | null;
  error: string | null;
  attempts: number;
  proxyUsed: string | null;
  createdAt: Date;
  updatedAt: Date;
}
