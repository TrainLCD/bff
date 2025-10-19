import { app } from './generated/stationapi.js';

const SERVICE_FQN = 'app.trainlcd.grpc.StationAPI';
const DEFAULT_ALLOWED_HEADERS =
	'content-type,authorization,x-requested-with,x-api-key,x-trace-id';
const EXPOSED_HEADERS = ['grpc-status', 'grpc-message'] as const;
const GATEWAY_USER_AGENT = 'sapi-bff-rest-gateway/0.1';

type GatewayEnv = Env & {
	GRPC_TARGET_ORIGIN?: string;
	GRPC_ALLOWED_ORIGINS?: string;
};

interface GatewayConfig {
	targetOrigin: string;
	allowedOrigins: readonly string[];
	allowAnyOrigin: boolean;
}

type MessageType = {
	create(properties?: Record<string, unknown>): any;
	encode(message: Record<string, unknown>): { finish(): Uint8Array };
	decode(reader: Uint8Array | ArrayBuffer, length?: number): any;
	toObject(message: any, options?: Record<string, unknown>): Record<string, unknown>;
	verify(message: Record<string, unknown>): string | null;
};

interface RouteMatch {
	methodName: string;
	requestType: MessageType;
	responseType: MessageType;
	payload: Record<string, unknown>;
	successStatus: number;
}

interface GrpcInvocationResult {
	object: Record<string, unknown>;
	trailers: Map<string, string>;
}

const grpcTypes = app.trainlcd.grpc;

export async function handleRestGatewayRequest(request: Request, env: GatewayEnv): Promise<Response> {
	let config: GatewayConfig;
	try {
		config = resolveConfig(env);
	} catch (error) {
		console.error('REST gateway misconfigured', error);
		const origin = request.headers.get('Origin');
		return buildJsonResponse(500, { error: 'Gateway is not configured' }, origin);
	}

	if (request.method === 'OPTIONS') {
		return handlePreflight(request, config);
	}

	const origin = request.headers.get('Origin');
	const allowedOrigin = resolveAllowedOrigin(origin, config);
	if (!allowedOrigin) {
		return buildJsonResponse(403, { error: 'Origin not allowed' }, null);
	}

	let route: RouteMatch | null;
	try {
		route = matchRoute(request);
	} catch (error) {
		console.error('Failed to match request route', error);
		const status = error instanceof GrpcError ? error.statusCode : 400;
		const message =
			error instanceof GrpcError ? error.publicMessage : 'Invalid REST route or parameters';
		return buildJsonResponse(status, { error: message }, allowedOrigin);
	}
	if (!route) {
		return buildJsonResponse(404, { error: 'Not Found' }, allowedOrigin);
	}

	try {
		const result = await invokeGrpc(route, config);
		return buildJsonResponse(route.successStatus, result.object, allowedOrigin, result.trailers);
	} catch (error) {
		console.error('Failed to invoke upstream gRPC service', error);
		const status = error instanceof GrpcError ? error.statusCode : 502;
		const message =
			error instanceof GrpcError
				? error.publicMessage
				: 'Upstream gRPC service responded with an error';
		return buildJsonResponse(status, { error: message }, allowedOrigin);
	}
}

function resolveConfig(env: GatewayEnv): GatewayConfig {
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

function resolveAllowedOrigin(origin: string | null, config: GatewayConfig): string | null {
	if (config.allowAnyOrigin) {
		return origin ?? '*';
	}
	if (!origin) {
		return null;
	}
	return config.allowedOrigins.includes(origin) ? origin : null;
}

function handlePreflight(request: Request, config: GatewayConfig): Response {
	const origin = request.headers.get('Origin');
	const allowedOrigin = resolveAllowedOrigin(origin, config);
	if (!allowedOrigin) {
		return buildJsonResponse(403, { error: 'Origin not allowed' }, null);
	}
	const requestedHeaders =
		request.headers.get('Access-Control-Request-Headers') ?? DEFAULT_ALLOWED_HEADERS;
	const headers = new Headers();
	headers.set('Access-Control-Allow-Origin', allowedOrigin);
	appendVary(headers, 'Origin');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	headers.set('Access-Control-Allow-Headers', requestedHeaders);
	headers.set('Access-Control-Max-Age', '1800');
	return new Response(null, { status: 204, headers });
}

function matchRoute(request: Request): RouteMatch | null {
	const url = new URL(request.url);
	const pathname = url.pathname.replace(/\/+$/, '') || '/';

	if (request.method === 'GET' && pathname === '/api/stations') {
		const idsParam = url.searchParams.get('ids');
		if (!idsParam) {
			throw new GrpcError(400, 'Missing "ids" query parameter');
		}
		const ids = idsParam
			.split(',')
			.map((value) => value.trim())
			.filter((value) => value.length > 0)
			.map((value) => Number.parseInt(value, 10))
			.filter((value) => Number.isFinite(value));
		if (ids.length === 0) {
			throw new GrpcError(400, 'Invalid "ids" query parameter');
		}
		return {
			methodName: 'GetStationByIdList',
			requestType: grpcTypes.GetStationByIdListRequest,
			responseType: grpcTypes.MultipleStationResponse,
			payload: { ids },
			successStatus: 200,
		};
	}

	if (request.method === 'GET') {
		const stationMatch = pathname.match(/^\/api\/stations\/(\d+)$/);
		if (stationMatch) {
			const id = Number.parseInt(stationMatch[1], 10);
			return {
				methodName: 'GetStationById',
				requestType: grpcTypes.GetStationByIdRequest,
				responseType: grpcTypes.SingleStationResponse,
				payload: { id },
				successStatus: 200,
			};
		}

		const searchMatch = pathname.match(/^\/api\/stations\/search$/);
		if (searchMatch) {
			const stationName = url.searchParams.get('name');
			if (!stationName) {
				throw new GrpcError(400, 'Missing "name" query parameter');
			}
			const limit = parseOptionalUint(url.searchParams.get('limit'));
			const fromStationGroupId = parseOptionalUint(url.searchParams.get('from_station_group_id'));
			return {
				methodName: 'GetStationsByName',
				requestType: grpcTypes.GetStationsByNameRequest,
				responseType: grpcTypes.MultipleStationResponse,
				payload: {
					station_name: stationName,
					limit,
					from_station_group_id: fromStationGroupId,
				},
				successStatus: 200,
			};
		}

		const lineMatch = pathname.match(/^\/api\/lines\/(\d+)$/);
		if (lineMatch) {
			const lineId = Number.parseInt(lineMatch[1], 10);
			return {
				methodName: 'GetLineById',
				requestType: grpcTypes.GetLineByIdRequest,
				responseType: grpcTypes.SingleLineResponse,
				payload: { line_id: lineId },
				successStatus: 200,
			};
		}
	}

	return null;
}

function parseOptionalUint(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function invokeGrpc(route: RouteMatch, config: GatewayConfig): Promise<GrpcInvocationResult> {
const requestType = route.requestType;
const responseType = route.responseType;

const validationError = requestType.verify(route.payload as Record<string, unknown>);
	if (validationError) {
		throw new GrpcError(400, `Invalid request payload: ${validationError}`);
	}

	const message = requestType.create(route.payload);
	const messageBytes = requestType.encode(message).finish();
	const framedBytes = frameGrpcWebMessage(messageBytes);

	const path = `/${SERVICE_FQN}/${route.methodName}`;
	const upstreamUrl = new URL(path, config.targetOrigin);

	const headers = new Headers();
	headers.set('content-type', 'application/grpc-web+proto');
	headers.set('x-grpc-web', '1');
	headers.set('x-user-agent', GATEWAY_USER_AGENT);
	headers.set('accept', 'application/grpc-web+proto');
	headers.set('grpc-accept-encoding', 'identity');

	const response = await fetch(upstreamUrl.toString(), {
		method: 'POST',
		headers,
		body: framedBytes,
	});

	if (!response.ok) {
		throw new GrpcError(502, `Upstream responded with HTTP ${response.status}`);
	}

	const bodyBytes = new Uint8Array(await response.arrayBuffer());
	const { messages, trailers } = parseGrpcWebFrames(bodyBytes);

	if (messages.length === 0) {
		throw new GrpcError(502, 'No message received from gRPC upstream');
	}
	const grpcStatus = Number.parseInt(trailers.get('grpc-status') ?? '0', 10);
	const grpcMessage = trailers.get('grpc-message') ?? 'unknown';
	if (grpcStatus !== 0) {
		throw new GrpcError(502, `gRPC status ${grpcStatus}: ${grpcMessage}`);
	}

	const decoded = responseType.decode(messages[0]);
	const object = responseType.toObject(decoded, {
		longs: Number,
		enums: String,
		defaults: true,
	});

	return { object, trailers };
}

function frameGrpcWebMessage(messageBytes: Uint8Array): Uint8Array {
	const frame = new Uint8Array(5 + messageBytes.length);
	frame[0] = 0; // no compression
	const view = new DataView(frame.buffer);
	view.setUint32(1, messageBytes.length, false);
	frame.set(messageBytes, 5);
	return frame;
}

function parseGrpcWebFrames(body: Uint8Array): { messages: Uint8Array[]; trailers: Map<string, string> } {
	const messages: Uint8Array[] = [];
	const trailers = new Map<string, string>();
	let offset = 0;
	while (offset + 5 <= body.length) {
		const flag = body[offset];
		const length =
			(body[offset + 1] << 24) |
			(body[offset + 2] << 16) |
			(body[offset + 3] << 8) |
			body[offset + 4];
		offset += 5;
		if (offset + length > body.length) {
			break;
		}
		const slice = body.subarray(offset, offset + length);
		offset += length;
		if ((flag & 0x80) === 0x80) {
			const trailerString = new TextDecoder().decode(slice);
			for (const line of trailerString.split('\r\n')) {
				const index = line.indexOf(':');
				if (index === -1) {
					continue;
				}
				const key = line.slice(0, index).trim().toLowerCase();
				const value = line.slice(index + 1).trim();
				if (key.length > 0) {
					trailers.set(key, value);
				}
			}
		} else {
			messages.push(slice);
		}
	}
	return { messages, trailers };
}

function buildJsonResponse(
	status: number,
	body: Record<string, unknown>,
	allowedOrigin: string | null,
	trailers?: Map<string, string>,
): Response {
	const headers = new Headers();
	headers.set('content-type', 'application/json; charset=utf-8');
	if (allowedOrigin) {
		headers.set('Access-Control-Allow-Origin', allowedOrigin);
		appendVary(headers, 'Origin');
	}
	if (trailers) {
		headers.set('Access-Control-Expose-Headers', [...EXPOSED_HEADERS].join(', '));
		for (const [key, value] of trailers) {
			if (EXPOSED_HEADERS.includes(key as (typeof EXPOSED_HEADERS)[number])) {
				headers.set(key, value);
			}
		}
	}
	return new Response(JSON.stringify(body), { status, headers });
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

class GrpcError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly publicMessage: string,
	) {
		super(publicMessage);
		this.name = 'GrpcError';
	}
}
