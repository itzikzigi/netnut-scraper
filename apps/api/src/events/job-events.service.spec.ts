import { ConfigService } from '@nestjs/config';
import { JobEventsService } from './job-events.service';

// Capture the 'pmessage' handler registered in onModuleInit so tests can
// simulate Redis publishes without a real connection.
let pmessageHandler: ((pattern: string, channel: string) => void) | undefined;
const psubscribe = jest.fn().mockResolvedValue(undefined);
const quit = jest.fn().mockResolvedValue(undefined);

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: (event: string, cb: (pattern: string, channel: string) => void) => {
      if (event === 'pmessage') pmessageHandler = cb;
    },
    psubscribe,
    quit,
  })),
);

function publish(jobId: string): void {
  pmessageHandler?.('job:*:done', `job:${jobId}:done`);
}

const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;

describe('JobEventsService', () => {
  let service: JobEventsService;

  beforeEach(async () => {
    jest.useFakeTimers();
    pmessageHandler = undefined;
    service = new JobEventsService(config);
    await service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('resolves when the matching job:<id>:done is published', async () => {
    const waited = service.waitFor('abc', 30_000);
    publish('abc');
    await expect(waited).resolves.toBeUndefined();
  });

  it('ignores publishes for other job ids', async () => {
    const waited = service.waitFor('abc', 30_000);
    publish('different');

    const settled = jest.fn();
    void waited.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    // still resolves on timeout
    jest.advanceTimersByTime(30_000);
    await expect(waited).resolves.toBeUndefined();
  });

  it('resolves on timeout when no publish arrives', async () => {
    const waited = service.waitFor('abc', 5_000);
    jest.advanceTimersByTime(5_000);
    await expect(waited).resolves.toBeUndefined();
  });

  // Regression: a single publish must wake EVERY concurrent waiter for the
  // same job id, not just the most recently registered one.
  it('resolves all concurrent waiters for the same job id on one publish', async () => {
    const a = service.waitFor('shared', 30_000);
    const b = service.waitFor('shared', 30_000);
    const c = service.waitFor('shared', 30_000);

    publish('shared');

    await expect(Promise.all([a, b, c])).resolves.toEqual([undefined, undefined, undefined]);
  });
});
