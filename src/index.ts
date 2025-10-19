/**
 * Cloudflare Workers entry point exposing REST endpoints backed by gRPC-Web upstream calls.
 */

import { handleRestGatewayRequest } from './restGateway';

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		return handleRestGatewayRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
