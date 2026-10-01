import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { createAuthDatabase } from '../persistence/AuthDatabase.js';

type Auth = ReturnType<typeof createAuthDatabase>['auth'];

/** Adapts Fastify's request to Better Auth's Fetch API handler. */
export function registerAuthRoutes(
  api: FastifyInstance,
  auth: Pick<Auth, 'handler'>,
  baseUrl: string,
  isGoogleAvailable = false,
): void {
  api.get('/api/v1/auth/google', () => ({ available: isGoogleAvailable }));

  /* Google's callback returns to the API root. This tiny page transfers the
     SDK's short-lived authorization code back to the registered desktop app. */
  const returnPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Return to Tro</title></head>
<body><p id="status">Returning to Tro…</p><script>
  const cookieName = 'better-auth.electron=';
  let attempts = 0;
  const timer = setInterval(() => {
    const cookie = document.cookie.split('; ').find((part) => part.startsWith(cookieName));
    if (cookie) {
      clearInterval(timer);
      document.cookie = 'better-auth.electron=; Max-Age=0; Path=/';
      location.replace('app.tro.desktop://auth/callback#token=' + cookie.slice(cookieName.length));
    } else if (++attempts >= 100) {
      clearInterval(timer);
      document.getElementById('status').textContent =
        'Could not return to Tro. Please try signing in again from the app.';
    }
  }, 100);
</script></body></html>`;
  for (const path of ['/', '/sign-in']) {
    api.get(path, (_request, reply) =>
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(returnPage),
    );
  }

  api.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, baseUrl);
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }),
      );

      reply.code(response.status);
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') {
          reply.header(name, value);
        }
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header('set-cookie', cookies);
      }

      return reply.send(response.body ? await response.text() : null);
    },
  });
}
