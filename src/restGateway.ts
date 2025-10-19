import { Reader } from 'protobufjs/minimal';
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
	create(properties?: Record<string, unknown>): unknown;
	encode(message: unknown): { finish(): Uint8Array };
	decode(reader: Uint8Array | Reader, length?: number): unknown;
	toObject(message: unknown, options?: Record<string, unknown>): Record<string, unknown>;
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

	if (request.method !== 'GET') {
		return null;
	}

	if (pathname === '/api/stations') {
		const idsParam = requireQueryParam(url, 'ids');
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

	if (pathname === '/api/stations/nearby') {
		const latitude = requireFloatParam(url, 'latitude');
		const longitude = requireFloatParam(url, 'longitude');
		const limit = parseOptionalUint(getQuery(url, 'limit'));
		return {
			methodName: 'GetStationsByCoordinates',
			requestType: grpcTypes.GetStationByCoordinatesRequest,
			responseType: grpcTypes.MultipleStationResponse,
			payload: cleanPayload({ latitude, longitude, limit }),
			successStatus: 200,
		};
	}

	if (pathname === '/api/stations/search') {
		const stationName = requireQueryParam(url, 'name');
		const limit = parseOptionalUint(getQuery(url, 'limit'));
		const fromStationGroupId = parseOptionalUint(getQuery(url, 'from_station_group_id', 'fromStationGroupId'));
		return {
			methodName: 'GetStationsByName',
			requestType: grpcTypes.GetStationsByNameRequest,
			responseType: grpcTypes.MultipleStationResponse,
			payload: cleanPayload({ stationName, limit, fromStationGroupId }),
			successStatus: 200,
		};
	}

	const trainTypesMatch = pathname.match(/^\/api\/stations\/(\d+)\/train-types$/);
	if (trainTypesMatch) {
		const stationId = Number.parseInt(trainTypesMatch[1], 10);
		return {
			methodName: 'GetTrainTypesByStationId',
			requestType: grpcTypes.GetTrainTypesByStationIdRequest,
			responseType: grpcTypes.MultipleTrainTypeResponse,
			payload: { stationId },
			successStatus: 200,
		};
	}

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

	const stationGroupMatch = pathname.match(/^\/api\/station-groups\/(\d+)\/stations$/);
	if (stationGroupMatch) {
		const groupId = Number.parseInt(stationGroupMatch[1], 10);
		return {
			methodName: 'GetStationByGroupId',
			requestType: grpcTypes.GetStationByGroupIdRequest,
			responseType: grpcTypes.MultipleStationResponse,
			payload: { groupId },
			successStatus: 200,
		};
	}

	const lineGroupMatch = pathname.match(/^\/api\/line-groups\/(\d+)\/stations$/);
	if (lineGroupMatch) {
		const lineGroupId = Number.parseInt(lineGroupMatch[1], 10);
		return {
			methodName: 'GetStationsByLineGroupId',
			requestType: grpcTypes.GetStationsByLineGroupIdRequest,
			responseType: grpcTypes.MultipleStationResponse,
			payload: { lineGroupId },
			successStatus: 200,
		};
	}

	if (pathname === '/api/lines/search') {
		const lineName = requireQueryParam(url, 'name');
		const limit = parseOptionalUint(getQuery(url, 'limit'));
		return {
			methodName: 'GetLinesByName',
			requestType: grpcTypes.GetLinesByNameRequest,
			responseType: grpcTypes.MultipleLineResponse,
			payload: cleanPayload({ lineName, limit }),
			successStatus: 200,
		};
	}

	const lineStationsMatch = pathname.match(/^\/api\/lines\/(\d+)\/stations$/);
	if (lineStationsMatch) {
		const lineId = Number.parseInt(lineStationsMatch[1], 10);
		const stationId = parseOptionalUint(getQuery(url, 'station_id', 'stationId'));
		return {
			methodName: 'GetStationsByLineId',
			requestType: grpcTypes.GetStationByLineIdRequest,
			responseType: grpcTypes.MultipleStationResponse,
			payload: cleanPayload({ lineId, stationId }),
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
			payload: { lineId },
			successStatus: 200,
		};
	}

	if (pathname === '/api/routes') {
		const fromStationGroupId = requireUintParam(url, 'from_station_group_id', 'fromStationGroupId');
		const toStationGroupId = requireUintParam(url, 'to_station_group_id', 'toStationGroupId');
		const pageSize = parseOptionalUint(getQuery(url, 'page_size', 'pageSize'));
		const pageToken = getQuery(url, 'page_token', 'pageToken') ?? undefined;
		return {
			methodName: 'GetRoutes',
			requestType: grpcTypes.GetRouteRequest,
			responseType: grpcTypes.RouteResponse,
			payload: cleanPayload({
				fromStationGroupId,
				toStationGroupId,
				pageSize,
				pageToken,
			}),
			successStatus: 200,
		};
	}

	if (pathname === '/api/route-types') {
		const fromStationGroupId = requireUintParam(url, 'from_station_group_id', 'fromStationGroupId');
		const toStationGroupId = requireUintParam(url, 'to_station_group_id', 'toStationGroupId');
		const pageSize = parseOptionalUint(getQuery(url, 'page_size', 'pageSize'));
		const pageToken = getQuery(url, 'page_token', 'pageToken') ?? undefined;
		return {
			methodName: 'GetRouteTypes',
			requestType: grpcTypes.GetRouteRequest,
			responseType: grpcTypes.RouteTypeResponse,
			payload: cleanPayload({
				fromStationGroupId,
				toStationGroupId,
				pageSize,
				pageToken,
			}),
			successStatus: 200,
		};
	}

	if (pathname === '/api/routes/connected') {
		const fromStationGroupId = requireUintParam(url, 'from_station_group_id', 'fromStationGroupId');
		const toStationGroupId = requireUintParam(url, 'to_station_group_id', 'toStationGroupId');
		return {
			methodName: 'GetConnectedRoutes',
			requestType: grpcTypes.GetConnectedStationsRequest,
			responseType: grpcTypes.RouteResponse,
			payload: { fromStationGroupId, toStationGroupId },
			successStatus: 200,
		};
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

function getQuery(url: URL, ...names: string[]): string | null {
	for (const name of names) {
		const value = url.searchParams.get(name);
		if (value !== null) {
			return value;
		}
	}
	return null;
}

function requireQueryParam(url: URL, ...names: string[]): string {
	const value = getQuery(url, ...names);
	if (!value) {
		throw new GrpcError(400, `Missing "${names[0]}" query parameter`);
	}
	return value;
}

function requireUintParam(url: URL, ...names: string[]): number {
	const raw = requireQueryParam(url, ...names);
	const parsed = parseOptionalUint(raw);
	if (parsed === undefined) {
		throw new GrpcError(400, `Invalid "${names[0]}" query parameter`);
	}
	return parsed;
}

function requireFloatParam(url: URL, name: string): number {
	const raw = requireQueryParam(url, name);
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) {
		throw new GrpcError(400, `Invalid "${name}" query parameter`);
	}
	return parsed;
}

function cleanPayload<T extends Record<string, unknown>>(payload: T): T {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	return cleaned as T;
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
