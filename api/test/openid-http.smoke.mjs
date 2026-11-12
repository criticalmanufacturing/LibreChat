// Build @librechat/api first, then run: node --test api/test/openid-http.smoke.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from 'openid-client';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
const require = createRequire(import.meta.url);
const { getOpenIdLocalHttpOptions } = require('@librechat/api');

test('loopback HTTP opt-in covers discovery, code exchange, JWKS, userinfo and refresh', async (t) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'local-key', alg: 'RS256', use: 'sig' };
  const requests = [];
  let issuer;
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url.includes('.well-known')) {
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }),
      );
      return;
    }
    if (request.url.endsWith('/jwks')) {
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.url.endsWith('/userinfo')) {
      response.end(JSON.stringify({ sub: 'local-user', name: 'Local User' }));
      return;
    }
    if (request.url.endsWith('/token')) {
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'local-key' })
        .setIssuer(issuer)
        .setSubject('local-user')
        .setAudience('local-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      response.end(
        JSON.stringify({
          access_token: 'local-access-token',
          refresh_token: 'local-refresh-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: token,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  issuer = `http://127.0.0.1:${server.address().port}/SecurityPortal/tenant/CMF`;

  const discover = (enabled) =>
    client.discovery(
      new URL(issuer),
      'local-client',
      { client_secret: 'local-secret' },
      undefined,
      getOpenIdLocalHttpOptions(new URL(issuer), enabled, client.allowInsecureRequests),
    );

  await assert.rejects(discover(false), /HTTPS/);
  const config = await discover(true);
  const tokens = await client.authorizationCodeGrant(
    config,
    new URL('http://localhost/GenAI/oauth/openid/callback?code=local-code'),
  );
  assert.equal(tokens.claims().sub, 'local-user');
  // Exercise JWKS fetching and signature verification, not just unsigned claims.
  await client.enableNonRepudiationChecks(config);
  const verified = await client.authorizationCodeGrant(
    config,
    new URL('http://localhost/GenAI/oauth/openid/callback?code=second-local-code'),
  );
  assert.equal(verified.claims().sub, 'local-user');
  const user = await client.fetchUserInfo(config, tokens.access_token, 'local-user');
  assert.equal(user.sub, 'local-user');
  const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token);
  assert.equal(refreshed.access_token, 'local-access-token');
  assert.ok(requests.some((url) => url.endsWith('/jwks')));
  assert.ok(requests.some((url) => url.endsWith('/userinfo')));
  assert.equal(requests.filter((url) => url.endsWith('/token')).length, 3);
});
