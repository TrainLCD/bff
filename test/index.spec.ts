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

beforeEach(() => {
	gatewayEnv.GRPC_TARGET_ORIGIN = 'https://grpc-stg.trainlcd.app';
	delete gatewayEnv.GRPC_ALLOWED_ORIGINS;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('REST to gRPC gateway', () => {
	it('returns station detail via gRPC GetStationById', async () => {
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

		const request = new IncomingRequest('https://worker.example.com/api/stations/1', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
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
	const body = await response.json();
	expect(body.station).toMatchObject({
		id: 1,
		groupId: 100,
		name: 'Tokyo',
		nameKatakana: 'トウキョウ',
	});
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example.com');
	});

	it('supports station list lookups via ids query', async () => {
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValueOnce(
			createGrpcSuccessResponse(grpc.MultipleStationResponse, {
				stations: [{ id: 1, groupId: 10, name: 'Tokyo', nameKatakana: 'トウキョウ' }],
			}),
		);

		const request = new IncomingRequest('https://worker.example.com/api/stations?ids=1,2', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
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

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.stations).toHaveLength(1);
	});

	it('proxies station group queries via GetStationByGroupId', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(createGrpcSuccessResponse(grpc.MultipleStationResponse, { stations: [] }));

		const request = new IncomingRequest('https://worker.example.com/api/station-groups/42/stations', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamUrl, init] = fetchMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://grpc-stg.trainlcd.app/app.trainlcd.grpc.StationAPI/GetStationByGroupId');
		const bodyInit = init?.body;
		expect(bodyInit).toBeInstanceOf(Uint8Array);
		const grpcRequestBody = decodeRequestPayload(bodyInit as Uint8Array, grpc.GetStationByGroupIdRequest);
		expect(grpcRequestBody).toEqual({ groupId: 42 });
		expect(response.status).toBe(200);
	});

	it('proxies coordinate-based station lookups', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(createGrpcSuccessResponse(grpc.MultipleStationResponse, { stations: [] }));

		const request = new IncomingRequest('https://worker.example.com/api/stations/nearby?latitude=35.0&longitude=139.0&limit=5', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamUrl, init] = fetchMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://grpc-stg.trainlcd.app/app.trainlcd.grpc.StationAPI/GetStationsByCoordinates');
		const bodyInit = init?.body;
		expect(bodyInit).toBeInstanceOf(Uint8Array);
		const grpcRequestBody = decodeRequestPayload(bodyInit as Uint8Array, grpc.GetStationByCoordinatesRequest);
		expect(grpcRequestBody).toEqual({ latitude: 35, longitude: 139, limit: 5 });
		expect(response.status).toBe(200);
	});

	it('proxies route lookups with pagination controls', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(createGrpcSuccessResponse(grpc.RouteResponse, { routes: [] }));

		const request = new IncomingRequest('https://worker.example.com/api/routes?from_station_group_id=1&to_station_group_id=2&page_size=20&page_token=abc', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamUrl, init] = fetchMock.mock.calls[0];
		expect(upstreamUrl).toBe('https://grpc-stg.trainlcd.app/app.trainlcd.grpc.StationAPI/GetRoutes');
		const bodyInit = init?.body;
		expect(bodyInit).toBeInstanceOf(Uint8Array);
		const grpcRequestBody = decodeRequestPayload(bodyInit as Uint8Array, grpc.GetRouteRequest);
		expect(grpcRequestBody).toEqual({
			fromStationGroupId: 1,
			toStationGroupId: 2,
			pageSize: 20,
			pageToken: 'abc',
		});
		expect(response.status).toBe(200);
	});

	it('validates missing query parameters', async () => {
		const request = new IncomingRequest('https://worker.example.com/api/stations/search', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Missing "name" query parameter' });
	});

	it('returns 500 when upstream origin is not configured', async () => {
		delete gatewayEnv.GRPC_TARGET_ORIGIN;
		const request = new IncomingRequest('https://worker.example.com/api/stations/1', {
			method: 'GET',
			headers: { origin: 'https://frontend.example.com' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'Gateway is not configured' });
	});
});
