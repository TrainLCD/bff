# sapi-bff

Cloudflare Workers-based backend-for-frontend (BFF) that exposes REST endpoints and bridges them to the upstream gRPC-Web service defined by `GRPC_TARGET_ORIGIN`. Requests are validated, transformed into protobuf payloads generated from `proto/stationapi.proto`, and dispatched over gRPC-Web, while responses are decoded and returned as JSON. Development, testing, and deployment rely on Wrangler v4 and Vitest.

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
- `GRPC_TARGET_ORIGIN` (required): Origin of the upstream gRPC-Web endpoint, for example `https://grpc-stg.trainlcd.app`. The worker returns HTTP 500 if this value is missing or invalid.
- `GRPC_ALLOWED_ORIGINS` (optional): Comma-separated list of origins allowed via CORS. Omit to allow all origins.

For local development set these in `.dev.vars` or the `vars` section of `wrangler.jsonc`. Configure environment-specific values before deploying.

## Local Development
```bash
npm run dev
```
- Runs `wrangler dev` and exposes the worker at `http://localhost:8787/`.
- The `compatibility_date` is `2025-10-11`; update it when adopting newer runtime capabilities.

## REST Endpoints (initial draft)
- `GET /api/stations/:id` → `StationAPI.GetStationById`
- `GET /api/stations?ids=1,2,3` → `StationAPI.GetStationByIdList`
- `GET /api/stations/search?name=<text>&limit=<n>&from_station_group_id=<id>` → `StationAPI.GetStationsByName`
- `GET /api/lines/:id` → `StationAPI.GetLineById`

Additional gRPC methods can be surfaced by extending the router in `src/restGateway.ts` with the desired field mapping.

## Testing
```bash
npm test
```
- Uses `cloudflare/test` and `@cloudflare/vitest-pool-workers` to exercise the Worker in a production-like environment, including gRPC-Web framing, CORS handling, and configuration failures.

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

## Updating gRPC Stubs
```bash
npm run proto:generate
```
- Compiles `proto/stationapi.proto` to `src/generated/stationapi.js` and `src/generated/stationapi.d.ts` using `protobufjs`.
- Re-run tests afterwards to ensure the REST–gRPC translations still behave as expected.

## Directory Highlights
- `src/index.ts` — Worker entry point delegating requests to the REST→gRPC gateway.
- `src/restGateway.ts` — REST router, CORS handling, and gRPC-Web invocation helpers.
- `src/generated/stationapi.js` — ProtobufJS static module generated from `proto/stationapi.proto`.
- `proto/stationapi.proto` — Source protocol buffer definitions for the upstream service.
- `test/index.spec.ts` — Vitest suite covering REST routing and gRPC-Web interactions.
- `vitest.config.mts` — Vitest configuration targeting the Workers pool.
- `wrangler.jsonc` — Worker metadata, compatibility date, and development/deployment settings.

## License
This project is released under the [MIT License](LICENSE).
