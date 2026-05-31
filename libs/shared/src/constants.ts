export const SCRAPE_QUEUE_NAME = 'scrape-jobs';

export const JOB_COMPLETED_CHANNEL = (jobId: string) => `job:${jobId}:done`;

// Redis key holding the scraped HTML for a job. TTL'd — Postgres keeps only metadata.
export const JOB_HTML_KEY = (jobId: string) => `job:${jobId}:html`;
