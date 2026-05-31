import { ConfigService } from '@nestjs/config';
import { ResultStoreService } from './result-store.service';

const set = jest.fn().mockResolvedValue('OK');
const get = jest.fn();
const quit = jest.fn().mockResolvedValue(undefined);

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({ set, get, quit })));

function configWith(ttl?: string): ConfigService {
  return {
    get: (key: string, d?: unknown) => (key === 'RESULT_TTL_SECONDS' ? (ttl ?? d) : d),
  } as unknown as ConfigService;
}

describe('ResultStoreService', () => {
  let service: ResultStoreService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ResultStoreService(configWith('120'));
    service.onModuleInit();
  });

  it('stores html under the per-job key with the configured TTL', async () => {
    await service.store('abc', '<html>x</html>');
    expect(set).toHaveBeenCalledWith('job:abc:html', '<html>x</html>', 'EX', 120);
  });

  it('defaults the TTL to 3600s when RESULT_TTL_SECONDS is unset', async () => {
    const svc = new ResultStoreService(configWith(undefined));
    svc.onModuleInit();
    await svc.store('abc', 'body');
    expect(set).toHaveBeenLastCalledWith('job:abc:html', 'body', 'EX', 3600);
  });

  it('reads html back, returning null on a miss/expiry', async () => {
    get.mockResolvedValueOnce('<html>y</html>');
    await expect(service.get('abc')).resolves.toBe('<html>y</html>');
    expect(get).toHaveBeenCalledWith('job:abc:html');

    get.mockResolvedValueOnce(null);
    await expect(service.get('missing')).resolves.toBeNull();
  });
});
