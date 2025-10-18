/**
 * Cloudflare Workers entry point routing gRPC-Web requests to the upstream service.
 */

import { handleGrpcWebProxyRequest } from './grpcProxy';

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		return handleGrpcWebProxyRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
