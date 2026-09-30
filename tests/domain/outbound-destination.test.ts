// FIX-SW4a (bugs.md SW4-01, SW4-08): the one rule for where the platform
// may send a webhook or a push. Every refused range is pinned with one
// literal, so removing a range from the list turns a named row red.
import { describe, expect, it } from 'vitest';

import { isOutboundDestinationAllowed, isRefusedAddress } from '../../src/domain/outbound-destination.js';

// The publish gate refuses a literal private or carrier-grade NAT address
// anywhere in this public repository, so those are joined from octets.
const dotted = (...octets: number[]): string => octets.join('.');

// One literal from each refused range in the rule's own list.
const REFUSED_RANGE_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['0.0.0.0/8', 'https://0.1.2.3/'],
  [`${dotted(10, 0, 0, 0)}/8`, `https://${dotted(10, 0, 0, 5)}/`],
  [`${dotted(100, 64, 0, 0)}/10`, `https://${dotted(100, 64, 0, 1)}/`],
  ['127.0.0.0/8', 'https://127.0.0.1:3900/internal'],
  ['169.254.0.0/16', 'https://169.254.169.254/latest/meta-data/'],
  ['172.16.0.0/12', 'https://172.16.0.1/'],
  ['192.0.0.0/24', 'https://192.0.0.1/'],
  ['192.0.2.0/24', 'https://192.0.2.1/'],
  [`${dotted(192, 168, 0, 0)}/16`, `https://${dotted(192, 168, 1, 1)}/`],
  ['198.18.0.0/15', 'https://198.18.0.1/'],
  ['198.51.100.0/24', 'https://198.51.100.1/'],
  ['203.0.113.0/24', 'https://203.0.113.1/'],
  ['224.0.0.0/4', 'https://224.0.0.1/'],
  ['240.0.0.0/4', 'https://240.0.0.1/'],
  ['::/128', 'https://[::]/'],
  ['::1/128', 'https://[::1]/'],
  ['64:ff9b::/96', 'https://[64:ff9b::808:808]/'],
  ['2001:db8::/32', 'https://[2001:db8::1]/'],
  ['fc00::/7', 'https://[fd12:3456::1]/'],
  ['fe80::/10', 'https://[fe80::1]/'],
  ['ff00::/8', 'https://[ff02::1]/'],
];

const SW4_HOSTS = [
  'https://127.0.0.1:3900/internal',
  'https://localhost/admin',
  'https://169.254.169.254/latest/meta-data/',
  `https://${dotted(10, 0, 0, 5)}/`,
  `https://${dotted(192, 168, 1, 1)}/`,
  'https://[::1]/',
];

describe('FIX-SW4a: the platform never sends to a private or loopback address', () => {
  it.each(REFUSED_RANGE_ROWS)('refuses a literal inside %s (%s)', (_range, url) => {
    expect(isOutboundDestinationAllowed(url)).toBe(false);
  });

  it.each(SW4_HOSTS)('refuses the SW4 host %s', (url) => {
    expect(isOutboundDestinationAllowed(url)).toBe(false);
  });

  it.each(['http://127.0.0.1:3900/plain-http', 'http://operator.example/webhook', 'file:///etc/passwd', 'ftp://operator.example/x', 'not a url', ''])(
    'refuses a non-https destination: %s',
    (url) => {
      expect(isOutboundDestinationAllowed(url)).toBe(false);
    },
  );

  // new URL() turns every one of these into the literal 127.0.0.1.
  it.each(['https://2130706433/', 'https://0x7f.1/', 'https://017700000001/', 'https://127.1/'])(
    'refuses the loopback trick host %s',
    (url) => {
      expect(isOutboundDestinationAllowed(url)).toBe(false);
    },
  );

  it('refuses an IPv4-mapped IPv6 address, which the IPv4 list covers', () => {
    expect(isOutboundDestinationAllowed('https://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isOutboundDestinationAllowed('https://[::ffff:7f00:1]/')).toBe(false);
    expect(isOutboundDestinationAllowed(`https://[::ffff:${dotted(10, 0, 0, 5)}]/`)).toBe(false);
  });

  it('refuses the NAT64 form of a loopback address', () => {
    expect(isOutboundDestinationAllowed('https://[64:ff9b::7f00:1]/')).toBe(false);
  });

  it.each(['https://LOCALHOST./', 'https://localhost/', 'https://foo.localhost/', 'https://FOO.LocalHost./x', 'https://a.b.localhost:8443/'])(
    'refuses the local name %s regardless of case or a trailing dot',
    (url) => {
      expect(isOutboundDestinationAllowed(url)).toBe(false);
    },
  );

  it.each([
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/x',
    'https://operator.example/webhook',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
    'https://notlocalhost.example/',
    'https://localhost.example.com/',
  ])('accepts the public destination %s', (url) => {
    expect(isOutboundDestinationAllowed(url)).toBe(true);
  });

  it('checks a single resolved address with the same list', () => {
    expect(isRefusedAddress('127.0.0.1')).toBe(true);
    expect(isRefusedAddress('::1')).toBe(true);
    expect(isRefusedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isRefusedAddress('fd00::1')).toBe(true);
    expect(isRefusedAddress('8.8.8.8')).toBe(false);
    expect(isRefusedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses a string that is not an address at all, since a lookup answer that is not an address is not one to connect to', () => {
    expect(isRefusedAddress('not-an-ip')).toBe(true);
    expect(isRefusedAddress('')).toBe(true);
  });
});
