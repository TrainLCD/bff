import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const proxyEnv = env as { GRPC_TARGET_ORIGIN?: string; GRPC_ALLOWED_ORIGINS?: string };

beforeEach(() => {
	proxyEnv.GRPC_TARGET_ORIGIN = 'https://grpc-stg.trainlcd.app';
	delete proxyEnv.GRPC_ALLOWED_ORIGINS;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('gRPC-Web proxy worker', () => {
	it('returns CORS preflight response for OPTIONS', async () => {
		const request = new IncomingRequest('https://worker.example.com/app.Service/Method', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://frontend.example.com',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'content-type,x-grpc-web',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example.com');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
		expect(response.headers.get('Access-Control-Allow-Headers')).toBe('content-type,x-grpc-web');
	});

	it('proxies POST requests to the upstream gRPC endpoint', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('upstream-response', {
				status: 200,
				headers: {
					'content-type': 'application/grpc-web+proto',
					'grpc-status': '0',
				},
			}),
		);

		const request = new IncomingRequest('https://worker.example.com/app.Service/Unary?debug=1', {
			method: 'POST',
			headers: {
				'content-type': 'application/grpc-web+proto',
				'x-grpc-web': '1',
				origin: 'https://frontend.example.com',
			},
			body: new Uint8Array([0, 0, 0, 0, 0]),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [upstreamRequest] = fetchMock.mock.calls[0];
		expect(upstreamRequest).toBeInstanceOf(Request);

		const upstreamUrl = new URL((upstreamRequest as Request).url);
		expect(upstreamUrl.origin).toBe('https://grpc-stg.trainlcd.app');
		expect(upstreamUrl.pathname).toBe('/app.Service/Unary');
		expect(await response.text()).toBe('upstream-response');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example.com');
		expect(response.headers.get('Access-Control-Expose-Headers')).toContain('grpc-status');
	});

	it('returns 500 when GRPC_TARGET_ORIGIN is not configured', async () => {
		delete proxyEnv.GRPC_TARGET_ORIGIN;

		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		const request = new IncomingRequest('https://worker.example.com/app.Service/Unary', {
			method: 'POST',
			headers: {
				origin: 'https://frontend.example.com',
			},
			body: new Uint8Array([0]),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('gRPC proxy is not configured');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example.com');
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
