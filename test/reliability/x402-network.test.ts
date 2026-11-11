// Payment networks in 402 responses (src/checks/reliability/x402-network.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNetwork,
  decodePaymentRequiredHeader,
  normalizeNetwork,
  payableOnMainnet,
  summarizeRequirements,
} from '../../src/checks/reliability/x402-network.js';

const ALGO_MAIN = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';
const ALGO_MAIN_LEGACY = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const ALGO_TEST_LEGACY = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';

test('Algorand: the legacy full-hash form and the spec 32-character form are the same network', () => {
  assert.equal(normalizeNetwork(ALGO_MAIN_LEGACY), ALGO_MAIN);
  assert.equal(normalizeNetwork(ALGO_MAIN), ALGO_MAIN);
  assert.equal(classifyNetwork(ALGO_MAIN_LEGACY), 'mainnet');
  assert.equal(classifyNetwork(ALGO_MAIN), 'mainnet');
  assert.equal(classifyNetwork(ALGO_TEST_LEGACY), 'testnet');
  assert.equal(classifyNetwork('algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe'), 'testnet');
});

test('x402 v1 network names map to CAIP-2', () => {
  assert.equal(normalizeNetwork('base'), 'eip155:8453');
  assert.equal(normalizeNetwork('Base-Sepolia'), 'eip155:84532');
  assert.equal(normalizeNetwork('algorand-testnet'), 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe');
  assert.equal(classifyNetwork('base'), 'mainnet');
  assert.equal(classifyNetwork('solana-devnet'), 'testnet');
  assert.equal(classifyNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'mainnet');
  assert.equal(classifyNetwork('eip155:84532'), 'testnet');
});

test('unknown networks are never counted as mainnet', () => {
  assert.equal(classifyNetwork('eip155:999999'), 'unknown');
  assert.equal(classifyNetwork('madeup'), 'unknown');
  assert.equal(payableOnMainnet(['eip155:999999', ALGO_TEST_LEGACY]), false);
  assert.equal(payableOnMainnet([ALGO_TEST_LEGACY, ALGO_MAIN_LEGACY]), true);
  assert.equal(payableOnMainnet([]), false);
});

test('summarizeRequirements reads accepts, version and the bazaar extension, as sent', () => {
  const s = summarizeRequirements({
    x402Version: 2,
    accepts: [{ network: ALGO_MAIN_LEGACY }, { network: ALGO_MAIN_LEGACY }, { network: 'eip155:8453' }, { scheme: 'exact' }],
    extensions: { bazaar: { info: {} } },
  });
  assert.deepEqual(s, { parsed: true, x402Version: 2, acceptedNetworks: [ALGO_MAIN_LEGACY, 'eip155:8453'], hasBazaarExtension: true });
  assert.equal(summarizeRequirements({ x402Version: 1, accepts: [{ network: 'base' }] }).hasBazaarExtension, false);
  for (const bad of [null, 'x', [], {}, { accepts: [] }, { accepts: 'no' }]) {
    assert.equal(summarizeRequirements(bad).parsed, false);
  }
});

test('decodePaymentRequiredHeader decodes base64 JSON and tolerates junk', () => {
  const body = { x402Version: 2, accepts: [{ network: ALGO_MAIN }] };
  assert.deepEqual(decodePaymentRequiredHeader(Buffer.from(JSON.stringify(body)).toString('base64')), body);
  assert.equal(decodePaymentRequiredHeader(null), null);
  assert.equal(decodePaymentRequiredHeader('%%%not base64 json'), null);
});

test('payableByCurrentSdk: Algorand legacy-only does not count; spec form, Base, Solana do', async () => {
  const { payableByCurrentSdk } = await import('../../src/checks/reliability/x402-network.js');
  assert.equal(payableByCurrentSdk([ALGO_MAIN_LEGACY]), false);
  assert.equal(payableByCurrentSdk([ALGO_MAIN_LEGACY, 'eip155:8453']), true, 'Base still payable');
  assert.equal(payableByCurrentSdk([ALGO_MAIN]), true);
  assert.equal(payableByCurrentSdk([ALGO_TEST_LEGACY]), false, 'testnet never counts');
  assert.equal(payableByCurrentSdk(['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']), true);
  assert.equal(payableByCurrentSdk([]), false);
});

test('algorandMainnetIdForm tells spec, legacy and both apart, ignoring testnet and other chains', async () => {
  const { algorandMainnetIdForm } = await import('../../src/checks/reliability/x402-network.js');
  assert.equal(algorandMainnetIdForm([ALGO_MAIN]), 'spec');
  assert.equal(algorandMainnetIdForm([ALGO_MAIN_LEGACY, 'eip155:8453']), 'legacy');
  assert.equal(algorandMainnetIdForm([ALGO_MAIN, ALGO_MAIN_LEGACY]), 'both');
  assert.equal(algorandMainnetIdForm([ALGO_TEST_LEGACY, 'eip155:8453']), null);
  assert.equal(algorandMainnetIdForm(['algorand']), 'spec', 'v1 name counts as the spec network, not legacy');
});
