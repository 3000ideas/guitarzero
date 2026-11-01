import { describe, expect, it } from 'vitest';
import { APP_VERSION, checkForUpdate } from '../src/version';

const fakeFetch = (body: unknown, ok = true, status = 200): typeof fetch =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

describe('checkForUpdate', () => {
  it('reports current when the server version equals this build', async () => {
    expect(await checkForUpdate(fakeFetch({ version: APP_VERSION }), 'http://x/')).toEqual({ kind: 'current' });
  });
  it('reports newer with the server version', async () => {
    expect(await checkForUpdate(fakeFetch({ version: 'v999 · abc · 2030-01-01' }), 'http://x/')).toEqual({ kind: 'newer', version: 'v999 · abc · 2030-01-01' });
  });
  it('reports errors for HTTP failures, bad bodies and network errors', async () => {
    expect((await checkForUpdate(fakeFetch({}, false, 404), 'http://x/')).kind).toBe('error');
    expect((await checkForUpdate(fakeFetch({ nope: 1 }), 'http://x/')).kind).toBe('error');
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await checkForUpdate(boom, 'http://x/')).kind).toBe('error');
  });
});
