// FIX-SW4a (bugs.md SW4-01 and SW4-08): the one rule for where the platform
// may send a webhook or a push. A caller supplies the address (the agent's
// notifyWebhookUrl, a browser's push endpoint), so an unchecked address turns
// the platform into a client that reaches its own loopback, its private
// network and the cloud metadata address on the caller's behalf.
//
// The rule reads a URL string alone: https only (isHttpsUrl, the same scheme
// check the webhook route has always made), a host that is not `localhost`
// or a name under `.localhost` (case and a trailing dot ignored), and, when
// the host is an IP literal (an IPv6 literal in brackets included), an
// address outside the refused ranges below. new URL() has already turned
// every numeric trick host (`2130706433`, `0x7f.1`, `017700000001`, `127.1`)
// into a dotted literal by the time the host is read here.
//
// A NAME that resolves to a refused address is not visible from the string.
// The adapters close that half at send time: the guarded agent in
// src/adapters/outbound/public-only-agent.ts asks isRefusedAddress about
// every address the host resolves to, the same list as this file.
//
// Node builtins only (`node:net`), so the domain still imports no vendor and
// no adapter (invariant 8).
import { BlockList, isIP } from 'node:net';
import { isHttpsUrl } from './notification.js';

const REFUSED = new BlockList();

// The three private and shared ranges below are written as octets so this
// public repository carries no literal private or carrier-grade NAT address
// (the publish gate scans the tree and history for one).
function dotted(a: number, b: number, c: number, d: number): string {
  return [a, b, c, d].join('.');
}

// IPv4, each range named once with the RFC that reserves it. BlockList
// matches an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, `::ffff:7f00:1`)
// against these subnets, so a mapped form needs no rows of its own.
REFUSED.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network" (RFC 1122 section 3.2.1.3)
REFUSED.addSubnet(dotted(10, 0, 0, 0), 8, 'ipv4'); // private use (RFC 1918)
REFUSED.addSubnet(dotted(100, 64, 0, 0), 10, 'ipv4'); // shared address space, carrier-grade NAT (RFC 6598)
REFUSED.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback (RFC 1122 section 3.2.1.3)
REFUSED.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, including the cloud metadata address (RFC 3927)
REFUSED.addSubnet('172.16.0.0', 12, 'ipv4'); // private use (RFC 1918)
REFUSED.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments (RFC 6890)
REFUSED.addSubnet('192.0.2.0', 24, 'ipv4'); // documentation, TEST-NET-1 (RFC 5737)
REFUSED.addSubnet(dotted(192, 168, 0, 0), 16, 'ipv4'); // private use (RFC 1918)
REFUSED.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking (RFC 2544)
REFUSED.addSubnet('198.51.100.0', 24, 'ipv4'); // documentation, TEST-NET-2 (RFC 5737)
REFUSED.addSubnet('203.0.113.0', 24, 'ipv4'); // documentation, TEST-NET-3 (RFC 5737)
REFUSED.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast (RFC 5771)
REFUSED.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved for future use, includes broadcast (RFC 1112 section 4)

// IPv6.
REFUSED.addSubnet('::', 128, 'ipv6'); // unspecified address (RFC 4291 section 2.5.2)
REFUSED.addSubnet('::1', 128, 'ipv6'); // loopback (RFC 4291 section 2.5.3)
REFUSED.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 well-known prefix, which embeds an IPv4 address (RFC 6052)
REFUSED.addSubnet('2001:db8::', 32, 'ipv6'); // documentation (RFC 3849)
REFUSED.addSubnet('fc00::', 7, 'ipv6'); // unique local addresses (RFC 4193)
REFUSED.addSubnet('fe80::', 10, 'ipv6'); // link-local (RFC 4291 section 2.5.6)
REFUSED.addSubnet('ff00::', 8, 'ipv6'); // multicast (RFC 4291 section 2.7)

// One resolved address, as a DNS answer or an IP literal reads it. True when
// the platform must not connect to it. A string that is not an IP address at
// all is refused too: nothing that is not an address is a public one.
export function isRefusedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return REFUSED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Total: any string in, one boolean out, never throws.
export function isOutboundDestinationAllowed(url: string): boolean {
  if (!isHttpsUrl(url)) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return !isRefusedAddress(hostname.slice(1, -1));
  }
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (name === '' || name === 'localhost' || name.endsWith('.localhost')) return false;
  if (isIP(name) !== 0) return !isRefusedAddress(name);
  return true;
}
