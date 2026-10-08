import { createHash } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createModelCredentials } from '../../../src/server/auth/ModelCredentials.js';

const secret = 'synthetic-secret-with-at-least-32-characters';
const signingKey = createHash('sha256').update('tro-model-gateway-v1:').update(secret).digest();

describe('model-only credentials', () => {
  it('preserves the signing format, claims and 15-minute lifetime', async () => {
    const credentials = createModelCredentials(secret);
    const before = Date.now();
    const credential = await credentials.issueModelCredential('student');
    const { payload } = await jwtVerify(credential.token, signingKey, {
      issuer: 'tro-api',
      audience: 'tro-model',
    });
    expect(payload).toMatchObject({ scope: 'model', sub: 'student' });
    expect(Date.parse(credential.expiresAt) - before).toBeGreaterThanOrEqual(15 * 60_000);
    expect(Date.parse(credential.expiresAt) - before).toBeLessThan(15 * 60_000 + 1000);
    expect(payload.exp).toBe(Math.floor(Date.parse(credential.expiresAt) / 1000));
    expect(await credentials.isModelCredentialValid(credential.token)).toBe(true);
    expect(
      await createModelCredentials('different-secret').isModelCredentialValid(credential.token),
    ).toBe(false);
  });

  it.each([
    { scope: 'other', subject: 'student', audience: 'tro-model', expiration: '15m' },
    { scope: 'model', subject: '', audience: 'tro-model', expiration: '15m' },
    { scope: 'model', subject: 'student', audience: 'other', expiration: '15m' },
    { scope: 'model', subject: 'student', audience: 'tro-model', expiration: '-1m' },
  ])(
    'rejects credentials outside the model scope or lifetime: $scope/$audience/$expiration',
    async ({ scope, subject, audience, expiration }) => {
      const token = await new SignJWT({ scope })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setIssuer('tro-api')
        .setAudience(audience)
        .setExpirationTime(expiration)
        .sign(signingKey);
      expect(await createModelCredentials(secret).isModelCredentialValid(token)).toBe(false);
    },
  );
});
