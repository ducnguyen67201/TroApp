import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthRoutes } from '../../../src/server/auth/RegisterAuthRoutes.js';

describe('browser return to the desktop', () => {
  it.each(['/', '/sign-in'])('serves a working SDK callback from %s', async (path) => {
    const api = Fastify();
    const handler = vi.fn<(request: Request) => Promise<Response>>();
    registerAuthRoutes(api, { handler }, 'http://127.0.0.1:3000');

    try {
      const response = await api.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const script = /<script>([\s\S]*?)<\/script>/.exec(response.body)?.[1];
      if (!script) throw new Error('The return page has no handoff script.');

      const document = { cookie: 'other=value; better-auth.electron=synthetic-code' };
      const replace = vi.fn<(url: string) => void>();
      let tick: (() => void) | undefined;
      const clearInterval = vi.fn<(id: number) => void>();
      /* Execute only our generated page, with synthetic cookies and no network
         or OS access. Capture the timer so its callback runs after assignment. */
      runInNewContext(script, {
        document,
        location: { replace },
        clearInterval,
        setInterval(callback: () => void) {
          tick = callback;
          return 1;
        },
      });
      if (!tick) throw new Error('The return page did not schedule the handoff.');
      tick();

      expect(replace).toHaveBeenCalledExactlyOnceWith(
        'app.tro.desktop://auth/callback#token=synthetic-code',
      );
      const target = replace.mock.calls[0]?.[0];
      if (!target) throw new Error('The return page did not produce a callback URL.');
      const url = new URL(target);
      /* Better Auth's installed handler compares host plus pathname, not just
         pathname. The old single-slash form produces //auth/callback. */
      expect('/' + url.hostname + url.pathname).toBe('/auth/callback');
      expect(url.protocol).toBe('app.tro.desktop:');
      expect(url.hash).toBe('#token=synthetic-code');
      expect(document.cookie).toBe('better-auth.electron=; Max-Age=0; Path=/');
      expect(clearInterval).toHaveBeenCalledWith(1);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
});
