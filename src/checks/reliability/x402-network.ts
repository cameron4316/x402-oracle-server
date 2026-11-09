// Payment networks named in an x402 402 response, and whether they are mainnets.
//
// Observations record networks exactly as the endpoint sent them. Normalizing happens only here, at
// scoring time, so a later fix to this table re-scores old observations without rewriting history.
//
// Two notations reach us:
//   - CAIP-2 ids (x402 v2), e.g. "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp".
//     Algorand has two forms in the wild: the spec-correct one, whose reference is the first 32
//     characters of the base64 genesis hash (CAIP-2 limits a reference to 32 characters), and the
//     legacy full-hash form GoPlausible's facilitator still advertises (see src/config.ts). Both
//     normalize to the 32-character form.
//   - x402 v1 network names, e.g. "base", "base-sepolia", "solana-devnet", "algorand-testnet".
//
// A network missing from this table is "unknown" and never counts as a mainnet: an oracle should not
// call an endpoint payable on a network it cannot vouch for.

export type NetworkClass = 'mainnet' | 'testnet' | 'unknown';

const ALGORAND_MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';
const ALGORAND_TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe';
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

// x402 v1 names -> CAIP-2.
const V1_NAMES: Record<string, string> = {
  algorand: ALGORAND_MAINNET,
  'algorand-mainnet': ALGORAND_MAINNET,
  'algorand-testnet': ALGORAND_TESTNET,
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  ethereum: 'eip155:1',
  sepolia: 'eip155:11155111',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  avalanche: 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
  optimism: 'eip155:10',
  arbitrum: 'eip155:42161',
  solana: SOLANA_MAINNET,
  'solana-devnet': SOLANA_DEVNET,
};

const CLASS: Record<string, NetworkClass> = {
  [ALGORAND_MAINNET]: 'mainnet',
  [ALGORAND_TESTNET]: 'testnet',
  [SOLANA_MAINNET]: 'mainnet',
  [SOLANA_DEVNET]: 'testnet',
  'eip155:1': 'mainnet',
  'eip155:8453': 'mainnet',
  'eip155:137': 'mainnet',
  'eip155:43114': 'mainnet',
  'eip155:10': 'mainnet',
  'eip155:42161': 'mainnet',
  'eip155:11155111': 'testnet',
  'eip155:84532': 'testnet',
  'eip155:80002': 'testnet',
  'eip155:43113': 'testnet',
  'hedera:mainnet': 'mainnet',
  'hedera:testnet': 'testnet',
};

/** One canonical id per network: v1 names become CAIP-2, Algorand's legacy full hash is truncated. */
export function normalizeNetwork(raw: string): string {
  const id = raw.trim();
  const v1 = V1_NAMES[id.toLowerCase()];
  if (v1) return v1;
  const colon = id.indexOf(':');
  if (colon <= 0) return id;
  const namespace = id.slice(0, colon).toLowerCase();
  const reference = id.slice(colon + 1);
  if (namespace === 'algorand') return `algorand:${reference.slice(0, 32)}`;
  return `${namespace}:${reference}`;
}

export function classifyNetwork(raw: string): NetworkClass {
  return CLASS[normalizeNetwork(raw)] ?? 'unknown';
}

/** True when at least one of the accepted networks is a known mainnet. */
export function payableOnMainnet(networks: readonly string[]): boolean {
  return networks.some((n) => classifyNetwork(n) === 'mainnet');
}

export interface PaymentRequirementsSummary {
  /** The 402 carried x402 payment requirements that parse, with at least one `accepts` entry. */
  parsed: boolean;
  x402Version: number | null;
  /** `accepts[].network`, exactly as sent (deduplicated, at most 10). */
  acceptedNetworks: string[];
  /** x402 v2 `extensions.bazaar` is present (catalog discovery metadata; never a score input). */
  hasBazaarExtension: boolean;
}

const NOT_PARSED: PaymentRequirementsSummary = { parsed: false, x402Version: null, acceptedNetworks: [], hasBazaarExtension: false };

/** Reads an x402 payment-requirements object (v2 PAYMENT-REQUIRED header JSON or v1 body). */
export function summarizeRequirements(value: unknown): PaymentRequirementsSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NOT_PARSED;
  const obj = value as { x402Version?: unknown; accepts?: unknown; extensions?: unknown };
  if (!Array.isArray(obj.accepts) || obj.accepts.length === 0) return NOT_PARSED;
  const networks = new Set<string>();
  for (const a of obj.accepts) {
    const n = (a as { network?: unknown } | null)?.network;
    if (typeof n === 'string' && n.length > 0 && n.length <= 128) networks.add(n);
    if (networks.size >= 10) break;
  }
  const ext = obj.extensions;
  return {
    parsed: true,
    x402Version: typeof obj.x402Version === 'number' ? obj.x402Version : null,
    acceptedNetworks: [...networks],
    hasBazaarExtension: !!ext && typeof ext === 'object' && 'bazaar' in (ext as object),
  };
}

/** Decodes the x402 v2 PAYMENT-REQUIRED header (base64 JSON). Null when absent or unreadable. */
export function decodePaymentRequiredHeader(header: string | null): unknown {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header.trim(), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
