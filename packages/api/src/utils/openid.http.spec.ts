import { getOpenIdLocalHttpOptions } from './openid';

describe('getOpenIdLocalHttpOptions', () => {
  const allowInsecureRequests = jest.fn();

  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'requires explicit opt-in for http://%s',
    (hostname) => {
      const issuer = new URL(`http://${hostname}/SecurityPortal/tenant/CMF`);
      expect(getOpenIdLocalHttpOptions(issuer, false, allowInsecureRequests)).toEqual({});
      expect(getOpenIdLocalHttpOptions(issuer, true, allowInsecureRequests)).toEqual({
        execute: [allowInsecureRequests],
      });
    },
  );

  it.each(['localhost', 'identity.example.com'])(
    'does not weaken HTTPS for %s even when opted in',
    (hostname) => {
      expect(
        getOpenIdLocalHttpOptions(new URL(`https://${hostname}`), true, allowInsecureRequests),
      ).toEqual({});
    },
  );

  it.each(['identity.example.com', 'localhost.example.com', '192.168.1.2', '0.0.0.0'])(
    'rejects an HTTP opt-in for non-loopback issuer %s',
    (hostname) => {
      expect(() =>
        getOpenIdLocalHttpOptions(new URL(`http://${hostname}`), true, allowInsecureRequests),
      ).toThrow('Insecure OpenID is only allowed for loopback HTTP issuers');
    },
  );
});
