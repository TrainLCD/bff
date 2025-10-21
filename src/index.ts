/**
 * Cloudflare Workers entry point exposing a GraphQL API backed by gRPC-Web upstream calls.
 */

import { handleGraphQLRequest } from './graphqlGateway';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return handleGraphQLRequest(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
