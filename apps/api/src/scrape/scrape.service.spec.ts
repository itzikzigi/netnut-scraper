import {
  GatewayTimeoutException,
  GoneException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobResponseDto, ResultStoreService } from '@app/shared';
import { ScrapeService } from './scrape.service';
import { JobManagerClient } from '../job-manager-client/job-manager-client.service';
import { JobEventsService } from '../events/job-events.service';

function job(overrides: Partial<JobResponseDto> = {}): JobResponseDto {
  return {
    id: 'job-1',
    url: 'http://example.com',
    status: 'pending',
    error: null,
    attempts: 0,
    proxyUsed: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ScrapeService', () => {
  let jm: jest.Mocked<Pick<JobManagerClient, 'createJob' | 'getJob'>>;
  let events: jest.Mocked<Pick<JobEventsService, 'waitFor'>>;
  let results: jest.Mocked<Pick<ResultStoreService, 'get'>>;
  let service: ScrapeService;

  const config = {
    get: (key: string, d?: unknown) => (key === 'SCRAPE_WAIT_TIMEOUT_MS' ? '1000' : d),
  } as unknown as ConfigService;

  beforeEach(() => {
    jm = { createJob: jest.fn(), getJob: jest.fn() };
    events = { waitFor: jest.fn().mockResolvedValue(undefined) };
    results = { get: jest.fn() };
    service = new ScrapeService(
      jm as unknown as JobManagerClient,
      events as unknown as JobEventsService,
      results as unknown as ResultStoreService,
      config,
    );
  });

  describe('submit (async, wait=false)', () => {
    it('creates the job and returns 202-style pending without waiting or reading the cache', async () => {
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));

      const result = await service.submit('http://example.com', false);

      expect(result).toEqual({ jobId: 'abc', status: 'pending' });
      expect(events.waitFor).not.toHaveBeenCalled();
      expect(jm.getJob).not.toHaveBeenCalled();
      expect(results.get).not.toHaveBeenCalled();
    });
  });

  describe('submit (sync, wait=true)', () => {
    it('returns html from the result cache when the job is already completed', async () => {
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'completed' }));
      results.get.mockResolvedValue('<html>hi</html>');

      const result = await service.submit('http://example.com', true);

      expect(results.get).toHaveBeenCalledWith('abc');
      expect(result).toEqual({ jobId: 'abc', status: 'completed', html: '<html>hi</html>' });
    });

    it('registers the waiter before the first DB check (race-safe ordering)', async () => {
      const order: string[] = [];
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));
      events.waitFor.mockImplementation(async () => {
        order.push('waitFor');
      });
      jm.getJob.mockImplementation(async () => {
        order.push('getJob');
        return job({ id: 'abc', status: 'completed' });
      });
      results.get.mockResolvedValue('x');

      await service.submit('http://example.com', true);

      expect(order[0]).toBe('waitFor');
    });

    it('waits, re-reads the DB, then returns cached html when it completes', async () => {
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));
      jm.getJob
        .mockResolvedValueOnce(job({ id: 'abc', status: 'in_progress' }))
        .mockResolvedValueOnce(job({ id: 'abc', status: 'completed' }));
      results.get.mockResolvedValue('done');

      const result = await service.submit('http://example.com', true);

      expect(events.waitFor).toHaveBeenCalledWith('abc', 1000);
      expect(jm.getJob).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ jobId: 'abc', status: 'completed', html: 'done' });
    });

    it('throws 410 Gone when completed but the cached result has expired', async () => {
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'completed' }));
      results.get.mockResolvedValue(null);

      await expect(service.submit('http://example.com', true)).rejects.toBeInstanceOf(
        GoneException,
      );
    });

    it('throws 503 when the job failed', async () => {
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'failed', error: 'boom' }));

      await expect(service.submit('http://example.com', true)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(results.get).not.toHaveBeenCalled();
    });

    it('throws 504 when the job is still unfinished after the wait', async () => {
      jm.createJob.mockResolvedValue(job({ id: 'abc' }));
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'in_progress' }));

      await expect(service.submit('http://example.com', true)).rejects.toBeInstanceOf(
        GatewayTimeoutException,
      );
    });
  });

  describe('getStatus', () => {
    it('does not touch the cache for an unfinished job', async () => {
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'pending', attempts: 2 }));

      const result = await service.getStatus('abc');

      expect(results.get).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'abc',
        status: 'pending',
        html: undefined,
        error: undefined,
        attempts: 2,
      });
    });

    it('returns cached html for a completed job', async () => {
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'completed', attempts: 1 }));
      results.get.mockResolvedValue('<html>ok</html>');

      const result = await service.getStatus('abc');

      expect(result.html).toBe('<html>ok</html>');
      expect(result.status).toBe('completed');
    });

    it('omits html when a completed job has expired from the cache', async () => {
      jm.getJob.mockResolvedValue(job({ id: 'abc', status: 'completed' }));
      results.get.mockResolvedValue(null);

      const result = await service.getStatus('abc');

      expect(result.html).toBeUndefined();
      expect(result.status).toBe('completed');
    });
  });
});
