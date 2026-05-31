import { ConfigService } from '@nestjs/config';
import { BlockedUrlError, UrlSafetyService, isBlockedAddress } from './url-safety.service';

function makeService(allowPrivate = false): UrlSafetyService {
  const config = {
    get: (key: string) => (key === 'ALLOW_PRIVATE_TARGETS' ? (allowPrivate ? 'true' : 'false') : undefined),
  } as unknown as ConfigService;
  return new UrlSafetyService(config);
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '::1', // IPv6 loopback
    '::', // unspecified
    'fe80::1', // link-local
    'fc00::1', // unique-local
    'fd12:3456::1', // unique-local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1', // IPv4-mapped private
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34', // example.com
    '2606:2800:220:1::', // public IPv6
    '::ffff:8.8.8.8', // IPv4-mapped public
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('rejects zero-padded / malformed octets', () => {
    expect(isBlockedAddress('010.0.0.1')).toBe(true);
    expect(isBlockedAddress('1.2.3.4.5')).toBe(true);
    expect(isBlockedAddress('256.1.1.1')).toBe(true);
  });
});

describe('UrlSafetyService.assertPublicUrl', () => {
  const svc = makeService();

  it('rejects non-http(s) protocols', async () => {
    await expect(svc.assertPublicUrl('ftp://example.com')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(svc.assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects malformed URLs', async () => {
    await expect(svc.assertPublicUrl('not a url')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects literal private/loopback IP targets', async () => {
    await expect(svc.assertPublicUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(svc.assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(svc.assertPublicUrl('http://[::1]:8080/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('allows a literal public IP target', async () => {
    await expect(svc.assertPublicUrl('http://8.8.8.8/')).resolves.toBeUndefined();
  });

  it('bypasses all checks when ALLOW_PRIVATE_TARGETS=true', async () => {
    const open = makeService(true);
    await expect(open.assertPublicUrl('http://127.0.0.1/')).resolves.toBeUndefined();
  });
});
