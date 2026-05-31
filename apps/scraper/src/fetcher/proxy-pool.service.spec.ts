import { ConfigService } from '@nestjs/config';
import { ProxyPoolService } from './proxy-pool.service';

/** Minimal ConfigService stub returning a fixed PROXY_POOL value. */
function configWith(proxyPool: string | undefined): ConfigService {
  return {
    get: (key: string, _default?: unknown) => (key === 'PROXY_POOL' ? proxyPool : _default),
  } as unknown as ConfigService;
}

describe('ProxyPoolService', () => {
  describe('parsing', () => {
    it('treats an unset pool as empty and fetches directly', () => {
      const pool = new ProxyPoolService(configWith(undefined));
      expect(pool.isEmpty()).toBe(true);
      expect(pool.next()).toBeNull();
    });

    it('trims whitespace and drops empty entries', () => {
      const pool = new ProxyPoolService(configWith(' http://a:1 , ,http://b:2 ,'));
      expect(pool.isEmpty()).toBe(false);
      expect(pool.next()).toBe('http://a:1');
      expect(pool.next()).toBe('http://b:2');
    });
  });

  describe('next() round-robin', () => {
    it('cycles through the pool and wraps around', () => {
      const pool = new ProxyPoolService(configWith('http://a:1,http://b:2,http://c:3'));
      const seen = [pool.next(), pool.next(), pool.next(), pool.next(), pool.next()];
      expect(seen).toEqual([
        'http://a:1',
        'http://b:2',
        'http://c:3',
        'http://a:1', // wrapped
        'http://b:2',
      ]);
    });
  });

  describe('describe() credential stripping', () => {
    it('keeps only protocol//host, dropping user:pass', () => {
      const pool = new ProxyPoolService(configWith('http://user:secret@proxy.example:8080'));
      expect(pool.describe('http://user:secret@proxy.example:8080')).toBe('http://proxy.example:8080');
    });

    it('leaves credential-free URLs intact', () => {
      const pool = new ProxyPoolService(configWith('http://proxy.example:8080'));
      expect(pool.describe('http://proxy.example:8080')).toBe('http://proxy.example:8080');
    });

    it('returns <invalid> for unparseable input rather than throwing', () => {
      const pool = new ProxyPoolService(configWith(undefined));
      expect(pool.describe('not a url')).toBe('<invalid>');
    });
  });
});
