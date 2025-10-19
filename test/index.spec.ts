import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { app } from '../src/generated/stationapi.js';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const grpc = app.trainlcd.grpc;
const gatewayEnv = env as { GRPC_TARGET_ORIGIN?: string; GRPC_ALLOWED_ORIGINS?: string };

const toGrpcFrame = (bytes: Uint8Array): Uint8Array => {
	const frame = new Uint8Array(5 + bytes.length);
	frame[0] = 0;
	const view = new DataView(frame.buffer);
	view.setUint32(1, bytes.length, false);
	frame.set(bytes, 5);
	return frame;
};

const toTrailerFrame = (trailers: Record<string, string>): Uint8Array => {
	const lines = Object.entries(trailers)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\r\n');
	const payload = new TextEncoder().encode(lines);
	const frame = new Uint8Array(5 + payload.length);
	frame[0] = 0x80;
	const view = new DataView(frame.buffer);
	view.setUint32(1, payload.length, false);
	frame.set(payload, 5);
	return frame;
};

type GeneratedMessageType = {
	decode(reader: Uint8Array | ArrayBuffer, length?: number): any;
	toObject(message: any, options?: Record<string, unknown>): Record<string, unknown>;
};

type GeneratedEncodeType = {
	create(properties?: Record<string, unknown>): any;
	encode(message: Record<string, unknown>): { finish(): Uint8Array };
};

const decodeRequestPayload = (bufferLike: Uint8Array, type: GeneratedMessageType): Record<string, unknown> => {
	const buffer = new Uint8Array(bufferLike);
	const length =
		(buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
	const payload = buffer.subarray(5, 5 + length);
	const message = type.decode(payload);
	return type.toObject(message, { longs: Number });
};

const createGrpcSuccessResponse = (responseType: GeneratedEncodeType, payload: Record<string, unknown>): Response => {
	const encoded = responseType.encode(responseType.create(payload)).finish();
	const body = new Uint8Array([
		...toGrpcFrame(encoded),
		...toTrailerFrame({ 'grpc-status': '0', 'grpc-message': 'OK' }),
	]);
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'application/grpc-web+proto' },
	});
};

const graphqlRequest = (query: string, variables: Record<string, unknown> = {}) =>
	new IncomingRequest('https://worker.example.com/graphql', {
		method: 'POST',
		headers: {
			origin: 'https://frontend.example.com',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ query, variables }),
	});

beforeEach(() => {
	gatewayEnv.GRPC_TARGET_ORIGIN = 'https://grpc-stg.trainlcd.app';
	delete gatewayEnv.GRPC_ALLOWED_ORIGINS;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('GraphQL gateway', () => {
	it('resolves station query via GetStationById', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				createGrpcSuccessResponse(grpc.SingleStationResponse, {
					station: {
						id: 1,
						groupId: 100,
						name: 'Tokyo',
						nameKatakana: 'トウキョウ',
					},
				}),
			);

		const query = `
			query GetStation($id: Int!) {
				station(id: $id) {
					id
					groupId
					name
					nameKatakana
				}
			}
		`;

		const request = graphqlRequest(query, { id: 1 });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamUrl, init] = fetchMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://grpc-stg.trainlcd.app/app.trainlcd.grpc.StationAPI/GetStationById');
		const bodyInit = init?.body;
		expect(bodyInit).toBeInstanceOf(Uint8Array);
		const grpcRequestBody = decodeRequestPayload(bodyInit as Uint8Array, grpc.GetStationByIdRequest);
		expect(grpcRequestBody).toEqual({ id: 1 });

		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.data.station).toEqual({
			id: 1,
			groupId: 100,
			name: 'Tokyo',
			nameKatakana: 'トウキョウ',
		});
	});

	it('resolves stations query via GetStationByIdList', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				createGrpcSuccessResponse(grpc.MultipleStationResponse, {
					stations: [{ id: 1, groupId: 10, name: 'Tokyo', nameKatakana: 'トウキョウ' }],
				}),
			);

		const query = `
			query Stations($ids: [Int!]!) {
				stations(ids: $ids) {
					id
					name
				}
			}
		`;

		const request = graphqlRequest(query, { ids: [1, 2] });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamUrl, init] = fetchMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://grpc-stg.trainlcd.app/app.trainlcd.grpc.StationAPI/GetStationByIdList');
		const bodyInit = init?.body;
		expect(bodyInit).toBeInstanceOf(Uint8Array);
		const grpcRequestBody = decodeRequestPayload(bodyInit as Uint8Array, grpc.GetStationByIdListRequest);
		expect(grpcRequestBody).toEqual({ ids: [1, 2] });

		const result = await response.json();
		expect(result.data.stations).toHaveLength(1);
		expect(result.errors).toBeUndefined();
	});

	it('resolves routes query with pagination parameters', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				createGrpcSuccessResponse(grpc.RouteResponse, {
					routes: [{ id: 9, stops: [] }],
					nextPageToken: 'token',
				}),
			);

	const query = `
		query Routes($from: Int!, $to: Int!, $size: Int, $token: String) {
			routes(
				fromStationGroupId: $from
				toStationGroupId: $to
				pageSize: $size
				pageToken: $token
			) {
					routes {
						id
					}
					nextPageToken
				}
			}
		`;

	const variables = { from: 1, to: 2, size: 10, token: 'abc' };
		const request = graphqlRequest(query, variables);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamUrl, init] = fetchMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://grpc-stg.trainlcd.app/app.trainlcd.grpc.StationAPI/GetRoutes');
		const bodyInit = init?.body;
		const grpcRequestBody = decodeRequestPayload(bodyInit as Uint8Array, grpc.GetRouteRequest);
		expect(grpcRequestBody).toEqual({
			fromStationGroupId: 1,
			toStationGroupId: 2,
			pageSize: 10,
			pageToken: 'abc',
		});

		const result = await response.json();
		expect(result.data.routes.routes).toHaveLength(1);
		expect(result.data.routes.nextPageToken).toBe('token');
	});

	it('returns GraphQL errors for invalid payloads', async () => {
		const request = new IncomingRequest('https://worker.example.com/graphql', {
			method: 'POST',
			headers: {
				origin: 'https://frontend.example.com',
				'content-type': 'application/json',
			},
			body: JSON.stringify({}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		const result = await response.json();
		expect(result.errors[0].message).toBe('Missing GraphQL query');
	});

	it('returns 500 when upstream origin is not configured', async () => {
		delete gatewayEnv.GRPC_TARGET_ORIGIN;
		const query = `
			query { station(id: 1) { id } }
		`;
		const request = graphqlRequest(query);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		const result = await response.json();
		expect(result.errors[0].message).toBe('Gateway is not configured');
	});
});
