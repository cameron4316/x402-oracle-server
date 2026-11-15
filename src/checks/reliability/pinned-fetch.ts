// Makes a probe connect only to addresses that were checked first.
//
// probe() (monitor.ts) resolves a host name and refuses private or reserved addresses. If fetch then
// resolved the name again by itself, a DNS server could give a public address to the check and a
// private one to the connection a moment later. So the probe hands its checked answer to the
// connection: fetch runs with a dispatcher whose DNS lookup returns only what was recorded here for
// that host, and fails for a host that was never checked. Nothing else resolves names for a probe.
//
// The dispatcher is an Agent of Node's own fetch implementation (undici) with default settings apart
// from the lookup, so a probe's request is byte for byte what it was before, and connections are
// pooled by the same rules. Node does not export that class, so it is taken from the dispatcher Node's
// fetch installs under the well-known symbol the `undici` package itself uses for it.
//
// Because that is not a documented API, it is proven at every start instead of assumed:
// pinnedDispatcher() first makes a real request to a local test server under a host name that cannot
// exist in DNS, and only succeeds if the request arrived, i.e. if the lookup was honoured. The
// monitor and both servers call it at startup and refuse to start if it fails, and probe() calls it
// before every probe, so nothing can probe unpinned.
import { createServer } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';

type Family = 4 | 6;
interface PinnedAddress {
  address: string;
  family: Family;
}
type Pin = { addresses: PinnedAddress[] } | { error: Error };

type LookupResult = string | Array<{ address: string; family: number }>;
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: LookupResult, family?: number) => void;
type Lookup = (hostname: string, options: unknown, callback?: unknown) => void;
type AgentClass = new (options: { connect: { lookup: Lookup } }) => { close(): Promise<void> };

// Latest checked answer per host. Bounded: the oldest entry goes first. A host evicted while its
// probe is still connecting simply fails that probe (the lookup finds nothing), never falls back.
const MAX_PINNED_HOSTS = 10_000;
const pins = new Map<string, Pin>();

function remember(host: string, pin: Pin): void {
  const key = host.toLowerCase();
  pins.delete(key);
  pins.set(key, pin);
  if (pins.size > MAX_PINNED_HOSTS) pins.delete(pins.keys().next().value as string);
}

function notFound(hostname: string, why: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (${why})`), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname });
}

/**
 * Records the addresses a probe may connect to for `host`. The caller must already have checked
 * every one of them (isRefusedAddress); this module only makes the connection use them.
 */
export function pinHost(host: string, addresses: ReadonlyArray<{ address: string }>): void {
  const usable = addresses.flatMap(({ address }): PinnedAddress[] => {
    const family = isIP(address);
    return family === 4 || family === 6 ? [{ address, family }] : [];
  });
  remember(host, usable.length > 0 ? { addresses: usable } : { error: notFound(host, 'no usable address') });
}

/** Makes any connection to `host` fail with `error` (it did not resolve, or it resolved to a refused address). */
export function failHost(host: string, error: Error): void {
  remember(host, { error });
}

function answer(pin: Pin | undefined, hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  if (!pin) return callback(notFound(hostname, 'not checked before connecting'));
  if ('error' in pin) return callback(pin.error);
  const wanted = options.family === 4 || options.family === 6 ? pin.addresses.filter((a) => a.family === options.family) : pin.addresses;
  if (wanted.length === 0) return callback(notFound(hostname, 'no address of the requested family'));
  if (options.all) return callback(null, wanted.map((a) => ({ address: a.address, family: a.family })));
  callback(null, wanted[0].address, wanted[0].family);
}

/** The DNS lookup given to the probe's connections (same calling convention as dns.lookup). Exported for tests. */
export const pinnedLookup: Lookup = (hostname, options, callback) => {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts = (options && typeof options === 'object' ? options : {}) as { all?: boolean; family?: number };
  const pin = pins.get(hostname.toLowerCase());
  // Like dns.lookup, never call back in the same tick.
  process.nextTick(answer, pin, hostname, opts, cb);
};

// The real fetch, captured before anything (a test, say) replaces the global.
const nativeFetch = globalThis.fetch;

function fetchAgentClass(): AgentClass {
  // Using any Fetch global makes Node load its fetch implementation, which installs the default dispatcher.
  new Headers();
  const current = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')] as { constructor?: unknown } | undefined;
  const Agent = current?.constructor as AgentClass | undefined;
  if (typeof Agent !== 'function' || Agent.name !== 'Agent') {
    throw new Error(
      `cannot pin probe connections: Node's fetch dispatcher is ${Agent ? `a ${Agent.name}` : 'missing'}, expected an undici Agent ` +
        `(Node ${process.version}). Probing without pinning is refused.`,
    );
  }
  return Agent;
}

// A real request under a name DNS can never resolve (RFC 6761 reserves .invalid): it reaches the
// local server only if this Node's Agent used our lookup.
async function proveLookupIsHonoured(Agent: AgentClass): Promise<void> {
  const server = createServer((_req, res) => res.writeHead(204).end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  let asked = 0;
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        asked++;
        const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
        const opts = (options && typeof options === 'object' ? options : {}) as { all?: boolean; family?: number };
        process.nextTick(answer, { addresses: [{ address: '127.0.0.1', family: 4 }] }, hostname, opts, cb);
      },
    },
  });
  try {
    const res = await nativeFetch(`http://pinned-fetch-self-test.invalid:${port}/`, {
      dispatcher: agent,
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    await res.body?.cancel();
    if (res.status !== 204 || asked === 0) throw new Error(`self-test answered ${res.status} after ${asked} lookup(s)`);
  } catch (err) {
    throw new Error(
      `cannot pin probe connections: this Node (${process.version}) did not use the supplied DNS lookup ` +
        `(${err instanceof Error ? err.message : String(err)}). Probing without pinning is refused.`,
    );
  } finally {
    await agent.close().catch(() => {});
    server.close();
  }
}

let ready: Promise<object> | undefined;

/**
 * The dispatcher every probe request must use. The first call proves, with a real local request,
 * that pinning works in this process, and rejects if it does not (a later call tries again).
 */
export function pinnedDispatcher(): Promise<object> {
  ready ??= (async () => {
    const Agent = fetchAgentClass();
    await proveLookupIsHonoured(Agent);
    return new Agent({ connect: { lookup: pinnedLookup } });
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}
