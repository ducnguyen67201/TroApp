import { describe, expect, it } from 'vitest';
import { readModelConnectionEnv } from '../../scripts/Env.js';

describe('safe model connection environment evidence', () => {
  it('distinguishes missing settings without changing the process environment', () => {
    expect(readModelConnectionEnv({})).toEqual({
      httpProxyConfigured: false,
      httpsProxyConfigured: false,
      allProxyConfigured: false,
      proxyExclusionsConfigured: false,
      environmentProxyRequested: false,
      customCaConfigured: false,
      tlsVerificationDisabled: false,
    });
  });

  it('reports presence and activation separately without exposing configuration values', () => {
    const environment = {
      HTTP_PROXY: 'http://private-user:private-password@private-proxy:8080',
      HTTPS_PROXY: 'http://private-proxy:8080',
      ALL_PROXY: 'socks5://private-proxy:1080',
      NO_PROXY: 'private-host',
      NODE_EXTRA_CA_CERTS: '/private-certificate-path',
      OPENAI_API_KEY: 'private-provider-key',
    };
    const evidence = readModelConnectionEnv(environment);
    expect(evidence).toMatchObject({
      httpProxyConfigured: true,
      httpsProxyConfigured: true,
      allProxyConfigured: true,
      proxyExclusionsConfigured: true,
      customCaConfigured: true,
      environmentProxyRequested: false,
      tlsVerificationDisabled: false,
    });
    expect(JSON.stringify(evidence)).not.toContain('private');
    expect(environment.NODE_EXTRA_CA_CERTS).toBe('/private-certificate-path');
  });

  it.each([
    { environment: { NODE_USE_ENV_PROXY: '1' }, arguments: [] },
    { environment: { NODE_OPTIONS: '--max-old-space-size=2048 --use-env-proxy' }, arguments: [] },
    { environment: {}, arguments: ['--use-env-proxy'] },
  ])(
    'recognizes explicit Node proxy activation: $environment',
    ({ environment, arguments: nodeArguments }) => {
      expect(readModelConnectionEnv(environment, nodeArguments).environmentProxyRequested).toBe(
        true,
      );
    },
  );

  it('recognizes lowercase proxy configuration and an explicit TLS override', () => {
    expect(
      readModelConnectionEnv({
        http_proxy: 'private-proxy',
        https_proxy: 'private-proxy',
        no_proxy: 'private-host',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        SSL_CERT_FILE: '/private-ca',
      }),
    ).toMatchObject({
      httpProxyConfigured: true,
      httpsProxyConfigured: true,
      proxyExclusionsConfigured: true,
      customCaConfigured: true,
      tlsVerificationDisabled: true,
    });
  });
});
