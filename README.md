# sapi-bff

Cloudflare Workers-based backend-for-frontend (BFF) that relays gRPC-Web requests to the upstream gRPC service specified by `GRPC_TARGET_ORIGIN`. The worker normalises CORS headers and gRPC metadata while relying on Wrangler v4 and Vitest for development, testing, and deployment.

## Prerequisites
- Node.js 18 or later
- npm, pnpm, or another Node.js package manager
- Cloudflare account (required for deployment)

Wrangler is bundled as a devDependency, so `npx wrangler` works without a global install.

## Setup
```bash
npm install
```

## Environment Variables
- `GRPC_TARGET_ORIGIN` (required): Origin of the upstream gRPC endpoint, for example `https://grpc-stg.trainlcd.app`. The worker returns HTTP 500 if this value is missing or invalid.
- `GRPC_ALLOWED_ORIGINS` (optional): Comma-separated list of origins allowed via CORS. Omit to allow all origins.

For local development set these in `.dev.vars` or the `vars` section of `wrangler.jsonc`. Configure environment-specific values before deploying.

## Local Development
```bash
npm run dev
```
- Runs `wrangler dev` and exposes the worker at `http://localhost:8787/`.
- The `compatibility_date` is `2025-10-11`; update it when adopting newer runtime capabilities.

## Testing
```bash
npm test
```
- Uses `cloudflare/test` and `@cloudflare/vitest-pool-workers` to exercise the worker in a production-like environment covering CORS, proxy forwarding, and configuration failures.

## Deployment
```bash
npm run deploy
```
- Run `npx wrangler login` the first time to authenticate with Cloudflare.
- Ensure `GRPC_TARGET_ORIGIN`, `GRPC_ALLOWED_ORIGINS`, and any additional bindings are defined for the target environment prior to deployment.

## Regenerating Type Definitions
```bash
npm run cf-typegen
```
- Wrangler refreshes `worker-configuration.d.ts` so the `Env` types stay aligned with your bindings.

## Directory Highlights
- `src/index.ts` — Worker entry point that delegates requests to the gRPC-Web proxy.
- `src/grpcProxy.ts` — Core proxy logic handling CORS, header sanitisation, and upstream forwarding.
- `test/index.spec.ts` — Tests for CORS preflight, gRPC forwarding, and configuration error handling.
- `vitest.config.mts` — Vitest configuration targeting the Workers pool.
- `wrangler.jsonc` — Worker metadata, compatibility date, and development/deployment settings.

## License
This project is released under the [MIT License](LICENSE).
