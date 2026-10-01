import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { GoogleIdentityProvider, VerifiedGoogleIdentity } from './AuthService.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().min(1),
  token_type: z.string().min(1),
  id_token: z.string().min(1),
  refresh_token: z.string().optional(),
});

const GoogleClaimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email(),
  email_verified: z.literal(true),
  nonce: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  picture: z.url().max(2048).optional(),
});

/** Validates Google's signed ID token; access and refresh tokens are never persisted. */
export function createGoogleIdentityProvider(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchResponse?: typeof fetch;
}): GoogleIdentityProvider {
  const fetchResponse = input.fetchResponse ?? fetch;
  const googleKeys = createRemoteJWKSet(GOOGLE_JWKS_URL, { [customFetch]: fetchResponse });

  return {
    async exchangeAuthorizationCode(exchange): Promise<VerifiedGoogleIdentity> {
      const response = await fetchResponse(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: input.redirectUri,
          grant_type: 'authorization_code',
          code: exchange.code,
          code_verifier: exchange.codeVerifier,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error('Google rejected the authorization code.');
      }

      const tokenResponse = TokenResponseSchema.parse(await response.json());
      const verified = await jwtVerify(tokenResponse.id_token, googleKeys, {
        issuer: GOOGLE_ISSUERS,
        audience: input.clientId,
        clockTolerance: 5,
      });
      const claims = GoogleClaimsSchema.parse(verified.payload);

      if (claims.nonce !== exchange.nonce) {
        throw new Error('Google returned an invalid nonce.');
      }

      return {
        googleSubject: claims.sub,
        email: claims.email,
        emailVerified: true,
        displayName: claims.name ?? null,
        avatarUrl: claims.picture ?? null,
      };
    },
  };
}
