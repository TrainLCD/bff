const DEFAULT_ALLOWED_HEADER_VALUE =
	'content-type,x-grpc-web,x-grpc-web-mode,x-user-agent,grpc-timeout,grpc-encoding,grpc-accept-encoding,authorization';
const EXPOSED_HEADERS = [
	'grpc-status',
	'grpc-message',
	'grpc-status-details-bin',
	'grpc-encoding',
	'grpc-accept-encoding',
] as const;
const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
]);

type ProxyEnv = Env & {
	GRPC_TARGET_ORIGIN?: string;
	GRPC_ALLOWED_ORIGINS?: string;
};

interface ProxyConfig {
	targetOrigin: string;
	allowedOrigins: readonly string[];
	allowAnyOrigin: boolean;
}

export async function handleGrpcWebProxyRequest(request: Request, env: ProxyEnv): Promise<Response> {
	let config: ProxyConfig;
	try {
		config = buildConfig(env);
	} catch (error) {
		console.error('gRPC proxy misconfigured', error);
		const origin = request.headers.get('Origin');
		return buildCorsResponse(500, 'gRPC proxy is not configured', origin);
	}

	if (request.method === 'OPTIONS') {
		return handlePreflight(request, config);
	}

	const origin = request.headers.get('Origin');
	const allowedOrigin = resolveAllowedOrigin(origin, config);
	if (!allowedOrigin) {
		return buildCorsResponse(403, 'Origin not allowed', null);
	}

	if (request.method !== 'POST') {
		return buildCorsResponse(405, 'Method Not Allowed', allowedOrigin, [['Allow', 'POST, OPTIONS']]);
	}

	try {
		const upstreamResponse = await forwardToUpstream(request, config);
		return buildProxyResponse(upstreamResponse, allowedOrigin);
	} catch (error) {
		console.error('Failed to reach upstream gRPC service', error);
		return buildCorsResponse(502, 'Bad Gateway', allowedOrigin);
	}
}

function buildConfig(env: ProxyEnv): ProxyConfig {
	const rawTargetOrigin = env.GRPC_TARGET_ORIGIN?.trim();
	if (!rawTargetOrigin) {
		throw new Error('Missing GRPC_TARGET_ORIGIN');
	}
	let targetOrigin: string;
	try {
		const parsed = new URL(rawTargetOrigin);
		targetOrigin = parsed.origin;
		if (!targetOrigin) {
			throw new Error('Invalid origin derived from GRPC_TARGET_ORIGIN');
		}
	} catch (parseError) {
		const message = parseError instanceof Error ? parseError.message : 'unknown error';
		throw new Error(`Invalid GRPC_TARGET_ORIGIN value: ${message}`);
	}
	const allowedOrigins = parseAllowedOrigins(env.GRPC_ALLOWED_ORIGINS);
	const allowAnyOrigin = allowedOrigins.includes('*');
	return {
		targetOrigin,
		allowedOrigins,
		allowAnyOrigin,
	};
}

function parseAllowedOrigins(input: string | undefined): string[] {
	if (!input) {
		return ['*'];
	}
	return input
		.split(',')
		.map((value) => value.trim())
		.filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

function resolveAllowedOrigin(origin: string | null, config: ProxyConfig): string | null {
	if (config.allowAnyOrigin) {
		return origin ?? '*';
	}
	if (!origin) {
		return null;
	}
	return config.allowedOrigins.includes(origin) ? origin : null;
}

function handlePreflight(request: Request, config: ProxyConfig): Response {
	const origin = request.headers.get('Origin');
	const allowedOrigin = resolveAllowedOrigin(origin, config);
	if (!allowedOrigin) {
		return buildCorsResponse(403, 'Origin not allowed', null);
	}
	const requestedHeaders =
		request.headers.get('Access-Control-Request-Headers') ?? DEFAULT_ALLOWED_HEADER_VALUE;
	const headers = new Headers();
	headers.set('Access-Control-Allow-Origin', allowedOrigin);
	appendVary(headers, 'Origin');
	headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
	headers.set('Access-Control-Allow-Headers', requestedHeaders);
	headers.set('Access-Control-Max-Age', '1800');
	return new Response(null, { status: 204, headers });
}

async function forwardToUpstream(request: Request, config: ProxyConfig): Promise<Response> {
	const incomingUrl = new URL(request.url);
	const upstreamUrl = new URL(incomingUrl.pathname + incomingUrl.search, config.targetOrigin);
	const headers = new Headers();
	for (const [key, value] of request.headers) {
		const lowerKey = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lowerKey) || lowerKey === 'origin') {
			continue;
		}
		headers.set(key, value);
	}
	if (!headers.has('te')) {
		headers.set('te', 'trailers');
	}
	headers.set('x-forwarded-host', incomingUrl.host);
	const upstreamRequest = new Request(upstreamUrl.toString(), {
		method: request.method,
		headers,
		body: request.body,
	});
	return fetch(upstreamRequest);
}

function buildProxyResponse(upstreamResponse: Response, allowedOrigin: string): Response {
	const headers = new Headers(upstreamResponse.headers);
	headers.set('Access-Control-Allow-Origin', allowedOrigin);
	appendVary(headers, 'Origin');
	mergeHeaderList(headers, 'Access-Control-Expose-Headers', EXPOSED_HEADERS);
	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers,
	});
}

function buildCorsResponse(
	status: number,
	message: string,
	allowedOrigin: string | null,
	additionalHeaders?: Iterable<[string, string]>,
): Response {
	const headers = new Headers();
	if (allowedOrigin) {
		headers.set('Access-Control-Allow-Origin', allowedOrigin);
		appendVary(headers, 'Origin');
	}
	if (additionalHeaders) {
		for (const [key, value] of additionalHeaders) {
			headers.set(key, value);
		}
	}
	return new Response(message, { status, headers });
}

function appendVary(headers: Headers, value: string): void {
	const existing = headers.get('Vary');
	const normalized = value.toLowerCase();
	if (!existing) {
		headers.set('Vary', value);
		return;
	}
	const parts = existing
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (!parts.map((part) => part.toLowerCase()).includes(normalized)) {
		parts.push(value);
		headers.set('Vary', parts.join(', '));
	}
}

function mergeHeaderList(headers: Headers, key: string, values: readonly string[]): void {
	const existing = headers.get(key);
	const merged = new Set<string>();
	if (existing) {
		for (const value of existing.split(',')) {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				merged.add(trimmed);
			}
		}
	}
	for (const value of values) {
		merged.add(value);
	}
	headers.set(key, Array.from(merged).join(', '));
}
