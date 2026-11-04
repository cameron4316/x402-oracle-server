# Public reports

Signed, dated reliability reports, served at `https://api.hosannaith.com/reports/<id>.json`.
Each file is generated on the server with `scripts/sign-report.ts` and is never edited after
publishing: a citation always points at the numbers it quoted. Verify any report with
`node_modules/.bin/tsx scripts/verify-signature.ts <file>` (see `docs/attestation.md`).
