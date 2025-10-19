import { Reader } from 'protobufjs/minimal';
import { graphql, buildSchema, GraphQLError } from 'graphql';
import { app } from './generated/stationapi.js';

const grpcTypes = app.trainlcd.grpc;
const SERVICE_FQN = 'app.trainlcd.grpc.StationAPI';
const DEFAULT_ALLOWED_HEADERS = 'content-type,authorization,x-requested-with,x-api-key,x-trace-id';
const GATEWAY_USER_AGENT = 'sapi-bff-graphql-gateway/0.1';

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

class GrpcError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly publicMessage: string,
	) {
		super(publicMessage);
		this.name = 'GrpcError';
	}
}

const schemaSDL = /* GraphQL */ `
	schema {
		query: Query
	}

	type Query {
		station(id: Int!): Station
		stations(ids: [Int!]!): [Station!]!
		stationsNearby(latitude: Float!, longitude: Float!, limit: Int): [Station!]!
		stationsByName(name: String!, limit: Int, fromStationGroupId: Int): [Station!]!
		stationGroupStations(groupId: Int!): [Station!]!
		lineGroupStations(lineGroupId: Int!): [Station!]!
		line(lineId: Int!): Line
		linesByName(name: String!, limit: Int): [Line!]!
		lineStations(lineId: Int!, stationId: Int): [Station!]!
		stationTrainTypes(stationId: Int!): [TrainType!]!
		routes(fromStationGroupId: Int!, toStationGroupId: Int!, pageSize: Int, pageToken: String): RoutePage!
		routeTypes(fromStationGroupId: Int!, toStationGroupId: Int!, pageSize: Int, pageToken: String): RouteTypePage!
		connectedRoutes(fromStationGroupId: Int!, toStationGroupId: Int!): [Route!]!
	}

	type RoutePage {
		routes: [Route!]
		nextPageToken: String
	}

	type RouteTypePage {
		trainTypes: [TrainType!]
		nextPageToken: String
	}

	type Station {
		id: Int
		groupId: Int
		name: String
		nameKatakana: String
		nameRoman: String
		nameChinese: String
		nameKorean: String
		threeLetterCode: String
		prefectureId: Int
		postalCode: String
		address: String
		latitude: Float
		longitude: Float
		openedAt: String
		closedAt: String
		status: String
		stationNumbers: [StationNumber!]
		stopCondition: String
		distance: Float
		hasTrainTypes: Boolean
		trainType: TrainType
		lines: [Line!]
		line: Line
	}

	type StationNumber {
		lineSymbol: String
		lineSymbolColor: String
		lineSymbolShape: String
		stationNumber: String
	}

	type Line {
		id: Int
		nameShort: String
		nameKatakana: String
		nameFull: String
		nameRoman: String
		color: String
		lineType: String
		lineSymbols: [LineSymbol!]
		status: String
		station: Station
		company: Company
		trainType: TrainType
		averageDistance: Float
	}

	type LineSymbol {
		symbol: String
		color: String
		shape: String
	}

	type Company {
		id: Int
		railroadId: Int
		nameShort: String
		nameKatakana: String
		nameFull: String
		nameEnglishShort: String
		nameEnglishFull: String
		url: String
		type: String
		status: String
		name: String
	}

	type TrainType {
		id: Int
		typeId: Int
		groupId: Int
		name: String
		nameKatakana: String
		nameRoman: String
		nameChinese: String
		nameKorean: String
		color: String
		lines: [Line!]
		line: Line
		direction: String
		kind: String
	}

	type Route {
		id: Int
		stops: [Station!]
	}
`;

const schema = buildSchema(schemaSDL);

export async function handleGraphQLRequest(request: Request, env: GatewayEnv): Promise<Response> {
	let config: GatewayConfig;
	try {
		config = resolveConfig(env);
	} catch (error) {
		console.error('GraphQL gateway misconfigured', error);
		return buildGraphQLErrorResponse(500, 'Gateway is not configured', null);
	}

	if (request.method === 'OPTIONS') {
		return handlePreflight(request, config);
	}

	const origin = request.headers.get('Origin');
	const allowedOrigin = resolveAllowedOrigin(origin, config);
	if (!allowedOrigin) {
		return buildGraphQLErrorResponse(403, 'Origin not allowed', null);
	}

	if (request.method !== 'POST') {
		return buildGraphQLErrorResponse(405, 'Method Not Allowed', allowedOrigin, [['Allow', 'POST, OPTIONS']]);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return buildGraphQLErrorResponse(400, 'Invalid JSON payload', allowedOrigin);
	}

	if (typeof body !== 'object' || body === null) {
		return buildGraphQLErrorResponse(400, 'Invalid GraphQL request body', allowedOrigin);
	}

	const { query, variables, operationName } = body as {
		query?: unknown;
		variables?: unknown;
		operationName?: unknown;
	};

	if (typeof query !== 'string') {
		return buildGraphQLErrorResponse(400, 'Missing GraphQL query', allowedOrigin);
	}

	const variableValues = typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : undefined;
	const operation = typeof operationName === 'string' ? operationName : undefined;

	const client = new GrpcClient(config);
	const rootValue = createResolvers(client);

	const result = await graphql({
		schema,
		source: query,
		variableValues,
		operationName: operation,
		rootValue,
	});

	return buildGraphQLResponse(result, allowedOrigin);
}

function createResolvers(client: GrpcClient) {
	return {
		station: async ({ id }: { id: number }) => {
			const payload = await client.call(
				'GetStationById',
				grpcTypes.GetStationByIdRequest,
				grpcTypes.SingleStationResponse,
				{ id },
			);
			return payload.station ?? null;
		},
		stations: async ({ ids }: { ids: number[] }) => {
			const payload = await client.call(
				'GetStationByIdList',
				grpcTypes.GetStationByIdListRequest,
				grpcTypes.MultipleStationResponse,
				{ ids },
			);
			return payload.stations ?? [];
		},
		stationsNearby: async ({
			latitude,
			longitude,
			limit,
		}: {
			latitude: number;
			longitude: number;
			limit?: number;
		}) => {
			const payload = await client.call(
				'GetStationsByCoordinates',
				grpcTypes.GetStationByCoordinatesRequest,
				grpcTypes.MultipleStationResponse,
				cleanPayload({ latitude, longitude, limit }),
			);
			return payload.stations ?? [];
		},
		stationsByName: async ({
			name,
			limit,
			fromStationGroupId,
		}: {
			name: string;
			limit?: number;
			fromStationGroupId?: number;
		}) => {
			const payload = await client.call(
				'GetStationsByName',
				grpcTypes.GetStationsByNameRequest,
				grpcTypes.MultipleStationResponse,
				cleanPayload({
					stationName: name,
					limit,
					fromStationGroupId,
				}),
			);
			return payload.stations ?? [];
		},
		stationGroupStations: async ({ groupId }: { groupId: number }) => {
			const payload = await client.call(
				'GetStationByGroupId',
				grpcTypes.GetStationByGroupIdRequest,
				grpcTypes.MultipleStationResponse,
				{ groupId },
			);
			return payload.stations ?? [];
		},
		lineGroupStations: async ({ lineGroupId }: { lineGroupId: number }) => {
			const payload = await client.call(
				'GetStationsByLineGroupId',
				grpcTypes.GetStationsByLineGroupIdRequest,
				grpcTypes.MultipleStationResponse,
				{ lineGroupId },
			);
			return payload.stations ?? [];
		},
		line: async ({ lineId }: { lineId: number }) => {
			const payload = await client.call(
				'GetLineById',
				grpcTypes.GetLineByIdRequest,
				grpcTypes.SingleLineResponse,
				{ lineId },
			);
			return payload.line ?? null;
		},
		linesByName: async ({ name, limit }: { name: string; limit?: number }) => {
			const payload = await client.call(
				'GetLinesByName',
				grpcTypes.GetLinesByNameRequest,
				grpcTypes.MultipleLineResponse,
				cleanPayload({ lineName: name, limit }),
			);
			return payload.lines ?? [];
		},
		lineStations: async ({ lineId, stationId }: { lineId: number; stationId?: number }) => {
			const payload = await client.call(
				'GetStationsByLineId',
				grpcTypes.GetStationByLineIdRequest,
				grpcTypes.MultipleStationResponse,
				cleanPayload({ lineId, stationId }),
			);
			return payload.stations ?? [];
		},
		stationTrainTypes: async ({ stationId }: { stationId: number }) => {
			const payload = await client.call(
				'GetTrainTypesByStationId',
				grpcTypes.GetTrainTypesByStationIdRequest,
				grpcTypes.MultipleTrainTypeResponse,
				{ stationId },
			);
			return payload.trainTypes ?? [];
		},
		routes: async ({
			fromStationGroupId,
			toStationGroupId,
			pageSize,
			pageToken,
		}: {
			fromStationGroupId: number;
			toStationGroupId: number;
			pageSize?: number;
			pageToken?: string;
		}) => {
			const payload = await client.call(
				'GetRoutes',
				grpcTypes.GetRouteRequest,
				grpcTypes.RouteResponse,
				cleanPayload({ fromStationGroupId, toStationGroupId, pageSize, pageToken }),
			);
			return {
				routes: payload.routes ?? [],
				nextPageToken: payload.nextPageToken ?? null,
			};
		},
		routeTypes: async ({
			fromStationGroupId,
			toStationGroupId,
			pageSize,
			pageToken,
		}: {
			fromStationGroupId: number;
			toStationGroupId: number;
			pageSize?: number;
			pageToken?: string;
		}) => {
			const payload = await client.call(
				'GetRouteTypes',
				grpcTypes.GetRouteRequest,
				grpcTypes.RouteTypeResponse,
				cleanPayload({ fromStationGroupId, toStationGroupId, pageSize, pageToken }),
			);
			return {
				trainTypes: payload.trainTypes ?? [],
				nextPageToken: payload.nextPageToken ?? null,
			};
		},
		connectedRoutes: async ({
			fromStationGroupId,
			toStationGroupId,
		}: {
			fromStationGroupId: number;
			toStationGroupId: number;
		}) => {
			const payload = await client.call(
				'GetConnectedRoutes',
				grpcTypes.GetConnectedStationsRequest,
				grpcTypes.RouteResponse,
				{ fromStationGroupId, toStationGroupId },
			);
			return payload.routes ?? [];
		},
	};
}

class GrpcClient {
	constructor(private readonly config: GatewayConfig) {}

	async call(
		methodName: string,
		requestType: MessageType,
		responseType: MessageType,
		payload: Record<string, unknown>,
	): Promise<Record<string, any>> {
		try {
			const validationError = requestType.verify(payload);
			if (validationError) {
				throw new GrpcError(400, `Invalid request payload: ${validationError}`);
			}
			const message = requestType.create(payload);
			const messageBytes = requestType.encode(message).finish();
			const framedBytes = frameGrpcWebMessage(messageBytes);
			const path = `/${SERVICE_FQN}/${methodName}`;
			const upstreamUrl = new URL(path, this.config.targetOrigin);
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
			return responseType.toObject(decoded, {
				longs: Number,
				enums: String,
				defaults: true,
			});
		} catch (error) {
			if (error instanceof GrpcError) {
				throw new GraphQLError(error.publicMessage, {
					extensions: {
						code: 'UPSTREAM_ERROR',
						http: { status: error.statusCode },
					},
				});
			}
			throw error;
		}
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
		return buildGraphQLErrorResponse(403, 'Origin not allowed', null);
	}
	const requestedHeaders =
		request.headers.get('Access-Control-Request-Headers') ?? DEFAULT_ALLOWED_HEADERS;
	const headers = new Headers();
	headers.set('Access-Control-Allow-Origin', allowedOrigin);
	appendVary(headers, 'Origin');
	headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
	headers.set('Access-Control-Allow-Headers', requestedHeaders);
	headers.set('Access-Control-Max-Age', '1800');
	return new Response(null, { status: 204, headers });
}

function buildGraphQLResponse(result: unknown, allowedOrigin: string | null): Response {
	const headers = new Headers();
	headers.set('content-type', 'application/json; charset=utf-8');
	if (allowedOrigin) {
		headers.set('Access-Control-Allow-Origin', allowedOrigin);
		appendVary(headers, 'Origin');
	}
	return new Response(JSON.stringify(result), { status: 200, headers });
}

function buildGraphQLErrorResponse(
	status: number,
	message: string,
	allowedOrigin: string | null,
	additionalHeaders?: Iterable<[string, string]>,
): Response {
	const headers = new Headers();
	headers.set('content-type', 'application/json; charset=utf-8');
	if (allowedOrigin) {
		headers.set('Access-Control-Allow-Origin', allowedOrigin);
		appendVary(headers, 'Origin');
	}
	if (additionalHeaders) {
		for (const [key, value] of additionalHeaders) {
			headers.set(key, value);
		}
	}
	return new Response(JSON.stringify({ errors: [{ message }] }), { status, headers });
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

function frameGrpcWebMessage(messageBytes: Uint8Array): Uint8Array {
	const frame = new Uint8Array(5 + messageBytes.length);
	frame[0] = 0;
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
