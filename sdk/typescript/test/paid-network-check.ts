// Paid end-to-end check of ONE Algorand network id against the live Hosannaith API.
// Makes exactly one paid call ($1.00 USDC on Algorand mainnet). Run it only deliberately.
//
//   cd sdk/typescript
//   pnpm install --frozen-lockfile
//   $env:AVM_MNEMONIC = Read-Host -MaskInput 'payer mnemonic'      # PowerShell; never typed on the command line
//   npx tsx test/paid-network-check.ts legacy                       # or: spec
//
// The client registers ONLY the chosen id, so it cannot fall back to the other one. It then reports:
//   1. the settlement receipt from the server (success, network, transaction, payer)
//   2. an explorer link for the on-chain transaction
//   3. whether the result's signature verifies against the published keys
// Exit code 0 only if all of that checks out. The mnemonic is read from the environment and never
// printed. (Not part of the npm package: test/ is excluded from it.)
import algosdk from 'algosdk';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactAvmScheme } from '@x402/avm';
import { verifyAttestation, type KeySet } from '../attest/verify.js';

const IDS = {
  spec: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  legacy: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
} as const;

const which = process.argv[2] as keyof typeof IDS | undefined;
const target = process.argv[3] ?? 'https://x402.goplausible.xyz/examples/weather';
const base = (process.env.HOSANNAITH_BASE_URL ?? 'https://api.hosannaith.com').replace(/\/+$/, '');
if (!which || !(which in IDS)) {
  console.error('usage: npx tsx test/paid-network-check.ts <legacy|spec> [target-url]');
  process.exit(2);
}
const mnemonic = (process.env.AVM_MNEMONIC ?? '').trim();
if (mnemonic.split(/\s+/).length !== 25) {
  console.error('Set AVM_MNEMONIC (25 words) in this shell first; see the header of this file.');
  process.exit(2);
}

const network = IDS[which];
const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic);
const signer: any = {
  address: String(addr),
  signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) =>
    txns.map((txn, i) =>
      indexesToSign && !indexesToSign.includes(i) ? null : algosdk.signTransaction(algosdk.decodeUnsignedTransaction(txn), sk).blob,
    ),
};
const client = new x402Client();
client.register(network, new ExactAvmScheme(signer)); // ONLY this id
const payingFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;

console.log(`Paying with ${which} id ${network}`);
console.log(`payer ${String(addr)}  target ${target}`);
const res = await payingFetch(`${base}/reliability?target=${encodeURIComponent(target)}`);
const header = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
const receipt = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : null;
const body = (await res.json().catch(() => null)) as Record<string, any> | null;

let ok = true;
const check = (label: string, pass: boolean, detail: string) => {
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
};

check('HTTP status', res.status === 200, String(res.status));
check('settlement success', receipt?.success === true, JSON.stringify(receipt?.success ?? null));
check('settled on the chosen id', receipt?.network === network, String(receipt?.network));
check('transaction id', typeof receipt?.transaction === 'string' && receipt.transaction.length > 0, String(receipt?.transaction));
if (receipt?.transaction) console.log(`      explorer: https://allo.info/tx/${receipt.transaction}`);
check('payer is this account', !receipt?.payer || receipt.payer === String(addr), String(receipt?.payer ?? '(not reported)'));

if (body?.signature) {
  const keys = (await (await fetch(`${base}/.well-known/hosannaith-keys.json`)).json()) as KeySet;
  const v = verifyAttestation(body, keys);
  check('signature verifies', v.ok, v.ok ? `kid ${v.kid}` : v.reason);
} else {
  check('signature present', false, 'result is not signed');
}
console.log(`      result: status=${body?.status} score=${body?.score} confidence=${body?.detail?.confidence}`);

console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
