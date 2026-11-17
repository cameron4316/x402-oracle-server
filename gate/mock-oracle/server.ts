// A small reliability oracle that speaks the response contract proposed for OpenEAGO
// (finos-labs/open-eago issue 72): spec field names, fractions in [0, 1], an explicit window, a
// confidence level, and an ES256 signature over the RFC 8785 canonical JSON.
//
// It exists for two reasons. It lets the gate be tried with no account, payment or network. And it
// is a second implementation of the contract, written from the proposal alone, which keeps the gate
// honest about being vendor neutral: nothing here knows about Hosannaith.
//
// THE NUMBERS ARE NOT MEASUREMENTS. They come from a scenario file, and every response says so.
// The signing key is made fresh at each start and never written to disk.
//
//   node mock-oracle/server.ts [--port 8787] [--scenario healthy|degraded|<file.json>]
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publicJwk } from '../src/attest/keys.ts';
import { attest, createSigner } from '../src/attest/sign.ts';

interface ServiceFigures {
  reliability_score: number;
  availability_pct: number;
  error_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  protocol_conformance?: number;
  observations_per_hour: number;
  confidence: 'history' | 'one-shot' | 'pending';
}

export interface Scenario {
  description: string;
  services: Record<string, ServiceFigures>;
}

export interface MockOracle {
  /** Base address, e.g. http://127.0.0.1:8787 (also the oracle id in every response). */
  url: string;
  kid: string;
  setScenario(scenario: Scenario): void;
  close(): Promise<void>;
}

const NOTICE = 'Mock data for demonstration. Not a measurement of any real service.';

export function loadScenario(nameOrPath: string): Scenario {
  const path = /[\\/.]/.test(nameOrPath) ? nameOrPath : fileURLToPath(new URL(`./scenarios/${nameOrPath}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Scenario;
}

export async function startMockOracle(options: { port?: number; scenario: Scenario; now?: () => Date }): Promise<MockOracle> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signer = createSigner(privateKey);
  const startedAt = new Date().toISOString();
  const now = options.now ?? (() => new Date());
  let scenario = options.scenario;
  let base = '';

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://127.0.0.1');
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });

    if (url.pathname === '/.well-known/keys.json') {
      return json(res, 200, {
        keys: [{ ...publicJwk(privateKey), kid: signer.kid, alg: 'ES256', use: 'sig', status: 'active', activated_at: startedAt }],
        revoked_keys: [],
      });
    }

    if (url.pathname === '/reliability') {
      const target = url.searchParams.get('target');
      const windowHours = Number(url.searchParams.get('window_hours') ?? 168);
      if (!target) return json(res, 400, { error: 'target is required' });
      if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 720) return json(res, 400, { error: 'window_hours must be 1 to 720' });
      const figures = Object.hasOwn(scenario.services, target) ? scenario.services[target] : undefined;
      if (!figures) return json(res, 404, { error: `no history for ${target}` });
      const { observations_per_hour, ...values } = figures;
      const at = now().toISOString();
      return json(
        res,
        200,
        attest(
          signer,
          {
            target,
            ...values,
            observations: observations_per_hour * windowHours,
            window_hours: windowHours,
            observed_at: at,
            oracle: { id: base, jwks_uri: `${base}/.well-known/keys.json` },
            notice: NOTICE,
          },
          at,
        ),
      );
    }

    if (url.pathname === '/') return json(res, 200, { service: 'mock reliability oracle', notice: NOTICE, scenario: scenario.description });
    return json(res, 404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock oracle: no TCP address');
  base = `http://127.0.0.1:${address.port}`;

  return {
    url: base,
    kid: signer.kid,
    setScenario(next) {
      scenario = next;
    },
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8787' }, scenario: { type: 'string', default: 'healthy' } } });
  const scenario = loadScenario(values.scenario);
  const oracle = await startMockOracle({ port: Number(values.port), scenario });
  console.log(`mock oracle on ${oracle.url} (scenario: ${scenario.description})`);
  console.log(`  ${NOTICE}`);
  console.log(`  keys: ${oracle.url}/.well-known/keys.json   signing key ${oracle.kid} (made at start, not saved)`);
  for (const target of Object.keys(scenario.services)) console.log(`  ${oracle.url}/reliability?target=${encodeURIComponent(target)}`);
}
