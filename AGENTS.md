# Repository Guidelines

## Project Structure & Module Organization
- Keep `src/index.ts` minimal; delegate logic to helper modules such as `src/graphqlGateway.ts`.
- Implement new GraphQL fields or gRPC-Web integrations in composable utilities under `src/` beside `graphqlGateway.ts`.
- Store protobuf assets under `proto/` and regenerate static modules in `src/generated/` when the schema changes.
- The GraphQL schema source of truth is `schema.graphql`; run `npm run schema:generate` to regenerate `src/schema.ts` after edits.
- Store shared tests in `/test` next to `index.spec.ts` and `env.d.ts`; add suites beside existing files for discoverability.
- Runtime configuration lives in `wrangler.jsonc`, while type generation flows through `worker-configuration.d.ts`. Application code compiles via `tsconfig.json`; tests use `test/tsconfig.json`.

## Environment Configuration
- Define `GRPC_TARGET_ORIGIN` with Wrangler `vars` for every environment. The worker returns HTTP 500 when the value is missing or invalid.
- Optionally configure `GRPC_ALLOWED_ORIGINS` as a comma-separated allowlist; omit to allow all origins.
- Use `.dev.vars` for local settings and `wrangler secret put` or `wrangler deploy --env` for remote secrets and variables.

## Build, Test, and Development Commands
- `npm run dev` / `npm start`: Start `wrangler dev` at `http://localhost:8787` with local bindings.
- `npm run test`: Execute Vitest against the Workers pool, covering CORS, proxy forwarding, and configuration-failure paths.
- `npm run deploy`: Deploy through Wrangler using the currently authenticated Cloudflare account.
- `npm run cf-typegen`: Regenerate runtime typings after updating `wrangler.jsonc` or rotating secrets.
- `npm run proto:generate`: Rebuild `src/generated/stationapi.js` / `.d.ts` from `proto/stationapi.proto` via `protobufjs`.
- `npm run schema:generate`: Regenerate `src/schema.ts` from `schema.graphql` - run this after modifying the GraphQL schema.

## Coding Style & Naming Conventions
- Preserve tab indentation and the existing single-blank-line grouping.
- TypeScript is `strict` with `noEmit`; annotate exported members explicitly and prefer `async/await`.
- Use `camelCase` for values, `PascalCase` for types, and verb-based helper names that describe behavior.

## Testing Guidelines
- Rely on Vitest with `@cloudflare/vitest-pool-workers`, using `SELF.fetch` and `createExecutionContext()` for realistic execution.
- Group specs by observable behaviour (GraphQL resolvers, gRPC-Web happy paths, validation failures) and cover both success and failure cases.
- When adding asynchronous side work, wait for `ctx.waitUntil()` by calling `waitOnExecutionContext`.
- Refresh inline snapshots via `npm run test -- --update` and review the resulting diffs before committing.

## Commit & Pull Request Guidelines
- Write imperative commit subjects within 72 characters (e.g., `Require gRPC origin config`).
- Check in regenerated artifacts (`worker-configuration.d.ts`, updated snapshots) alongside the changes that produced them.
- PR descriptions should state scope, testing evidence (`npm run test`, manual verification), related issues, and any new bindings or secrets with setup steps.

## Cloudflare Workers Operations
- Register secrets with `wrangler secret put` and document required keys outside version control.
- Use `wrangler tail` before promotion to confirm upstream availability and CORS headers.
- Compare `wrangler dev --local` with remote mode to evaluate latency, TLS behavior, and service bindings.
