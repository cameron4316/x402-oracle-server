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

// Base64 of a 32-byte genesis hash: the reference of Algorand's legacy full-hash network id.
const ALGORAND_FULL_HASH = /^[A-Za-z0-9+/]{43}=$/;

/** One canonical id per network: v1 names become CAIP-2, Algorand's legacy full hash is truncated. */
export function normalizeNetwork(raw: string): string {
  const id = raw.trim();
  const lower = id.toLowerCase();
  if (Object.hasOwn(V1_NAMES, lower)) return V1_NAMES[lower];
  const colon = id.indexOf(':');
  if (colon <= 0) return id;
  const namespace = id.slice(0, colon).toLowerCase();
  const reference = id.slice(colon + 1);
  // Only a real full genesis hash is truncated. Any other long reference stays as sent, and so stays
  // "unknown": a string that merely STARTS with a known id must not count as that network.
  if (namespace === 'algorand' && ALGORAND_FULL_HASH.test(reference)) return `algorand:${reference.slice(0, 32)}`;
  return `${namespace}:${reference}`;
}

export function classifyNetwork(raw: string): NetworkClass {
  const id = normalizeNetwork(raw);
  return Object.hasOwn(CLASS, id) ? CLASS[id] : 'unknown';
}

// A monitored endpoint chooses the text of `accepts[].network`, and a Hosannaith result is read by
// AI agents (MCP tool output, API responses). To keep an endpoint from passing free text through us
// to an agent, a network string is relayed in a result ONLY when it is shaped like a network id:
//   - CAIP-2 grammar: namespace [-a-z0-9]{3,8}, ":", reference [-_a-zA-Z0-9]{1,32}
//   - Algorand's legacy form: "algorand:" + a base64 full genesis hash (44 characters)
//   - an x402 v1 network name from the table above
// No spaces and at most 53 characters, so it cannot carry instructions to a reader.
// Observations keep the string as sent; this only decides what a result repeats.
const CAIP2_ID = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

/** Whether a network string from a 402 is a well-formed network id that a result may repeat. */
export function isRelayableNetworkId(raw: string): boolean {
  if (CAIP2_ID.test(raw)) return true;
  if (raw.startsWith('algorand:') && ALGORAND_FULL_HASH.test(raw.slice('algorand:'.length))) return true;
  return Object.hasOwn(V1_NAMES, raw.toLowerCase());
}

/** True when at least one of the accepted networks is a known mainnet. */
export function payableOnMainnet(networks: readonly string[]): boolean {
  return networks.some((n) => classifyNetwork(n) === 'mainnet');
}

/** An Algorand id in the legacy full-genesis-hash form (reference longer than CAIP-2's 32 chars). */
function isAlgorandLegacyId(raw: string): boolean {
  const id = raw.trim();
  return id.toLowerCase().startsWith('algorand:') && ALGORAND_FULL_HASH.test(id.slice('algorand:'.length));
}

/**
 * True when at least one accepted network is a known mainnet in a form the CURRENT x402 SDK accepts.
 * Since @x402/core and @x402/avm 2.29.0 (x402-foundation/x402 #3894) the SDK refuses Algorand's
 * legacy full-hash id, so an endpoint whose only mainnet option is that id cannot be paid by an
 * up-to-date client, even though older clients and the GoPlausible facilitator still accept it.
 */
export function payableByCurrentSdk(networks: readonly string[]): boolean {
  return networks.some((n) => classifyNetwork(n) === 'mainnet' && !isAlgorandLegacyId(n));
}

export type AlgorandIdForm = 'spec' | 'legacy' | 'both';

/** Which form(s) of the Algorand MAINNET id the networks use; null when Algorand mainnet is absent. */
export function algorandMainnetIdForm(networks: readonly string[]): AlgorandIdForm | null {
  let spec = false;
  let legacy = false;
  for (const n of networks) {
    if (normalizeNetwork(n) !== ALGORAND_MAINNET) continue;
    if (isAlgorandLegacyId(n)) legacy = true;
    else spec = true;
  }
  return spec && legacy ? 'both' : spec ? 'spec' : legacy ? 'legacy' : null;
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
