import {
  SignJWT,
  UnsecuredJWT,
  exportJWK,
  generateKeyPair,
  importJWK
} from 'jose'

import { roles } from '#/common/constants/roles.js'

const TENANT_ID = '11111111-2222-4333-8444-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_GUID = '99999999-8888-4777-8666-555555555555'
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`
const JWKS_URI = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`
const KEY_ID = 'test-signing-key'
const FIVE_MINUTES_IN_SECONDS = 5 * 60

// Obviously fake user details: no real personal data in tests
const testUser = {
  oid: '00000000-0000-4000-8000-000000000001',
  name: 'Test User',
  preferred_username: 'test.user@example.com'
}

const configuredEnv = { ENTRA_TENANT_ID: TENANT_ID, ENTRA_CLIENT_ID: CLIENT_ID }
const unconfiguredEnv = { ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '' }

const testOnlyRoutes = [
  {
    method: 'GET',
    path: '/test-only/credentials',
    handler: (request) => request.auth.credentials
  },
  {
    method: 'GET',
    path: '/test-only/administration',
    options: { auth: { access: { scope: [roles.administrator] } } },
    handler: () => ({ message: 'success' })
  },
  {
    method: 'GET',
    path: '/test-only/optional-sign-in',
    options: { auth: { mode: 'optional' } },
    handler: (request) => ({ signedIn: request.auth.isAuthenticated })
  }
]

let signingKey
let samePublicKeyWithPs256
let unknownSigningKey
let publicJwk

function nowInSeconds() {
  return Math.floor(Date.now() / 1000)
}

function signAccessToken({
  claims = {},
  key = signingKey,
  issuer = ISSUER,
  audience = CLIENT_ID,
  expiresAt = nowInSeconds() + FIVE_MINUTES_IN_SECONDS,
  notBefore,
  algorithm = 'RS256'
} = {}) {
  const token = new SignJWT({
    ...testUser,
    scp: 'access_as_user',
    roles: [],
    ...claims
  })
    .setProtectedHeader({ alg: algorithm, kid: KEY_ID, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)

  if (notBefore) {
    token.setNotBefore(notBefore)
  }

  return token.sign(key)
}

// Entra's keys are only served at the tenant's v2.0 keys URL, so a token can
// only be accepted if the service fetched its keys from there
function serveSigningKeys() {
  globalThis.fetchMock.mockResponse((request) =>
    request.url === JWKS_URI
      ? {
          body: JSON.stringify({ keys: [publicJwk] }),
          headers: { 'content-type': 'application/json' }
        }
      : { status: 404, body: '' }
  )
}

async function createTestServer(env) {
  vi.resetModules()
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value)
  }
  const { createServer } = await import('#/server.js')
  const server = await createServer()
  server.route(testOnlyRoutes)
  return server
}

async function initialiseAndRecordStartUpWarnings(server) {
  const warnSpy = vi.spyOn(server.logger, 'warn')
  await server.initialize()
  // Copy the calls now: vitest clears spies before each test
  return warnSpy.mock.calls.map((args) => [...args])
}

function captureRequestLogs(server) {
  const logs = []
  server.ext('onRequest', (request, h) => {
    for (const level of ['warn', 'error']) {
      vi.spyOn(request.logger, level).mockImplementation((...args) => {
        logs.push({ level, args })
      })
    }
    return h.continue
  })
  return logs
}

function rejectedTokenLog(reason) {
  return {
    level: 'warn',
    args: [
      { event: { category: ['authentication'], outcome: 'failure', reason } },
      'Access token rejected'
    ]
  }
}

function callWithAuthorization(server, url, authorization) {
  return server.inject({
    method: 'GET',
    url,
    headers: authorization ? { authorization } : {}
  })
}

function callWithToken(server, url, token) {
  return callWithAuthorization(server, url, `Bearer ${token}`)
}

function expectMissingTokenResponse(response) {
  expect(response.statusCode).toBe(401)
  expect(response.headers['www-authenticate']).toBe('Bearer')
  expect(JSON.parse(response.payload)).toEqual({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Missing authentication'
  })
}

function expectInvalidTokenResponse(response) {
  expect(response.statusCode).toBe(401)
  expect(response.headers['www-authenticate']).toBe(
    'Bearer error="invalid_token"'
  )
  expect(JSON.parse(response.payload)).toEqual({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'invalid_token',
    attributes: { error: 'invalid_token' }
  })
}

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true })
  signingKey = keyPair.privateKey
  // No `alg` on the published key, as with Entra's real keys, so only the
  // service's algorithm allow-list can refuse a PS256 token signed with it
  publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: KEY_ID }
  samePublicKeyWithPs256 = await importJWK(
    await exportJWK(keyPair.privateKey),
    'PS256'
  )
  unknownSigningKey = (await generateKeyPair('RS256')).privateKey
})

afterAll(() => {
  vi.unstubAllEnvs()
  globalThis.fetchMock.resetMocks()
})

describe('#auth Microsoft Entra ID access tokens', () => {
  describe('When Microsoft Entra ID is configured', () => {
    let server
    let logs
    let startUpWarnings

    beforeAll(async () => {
      serveSigningKeys()
      server = await createTestServer(configuredEnv)
      logs = captureRequestLogs(server)
      startUpWarnings = await initialiseAndRecordStartUpWarnings(server)
    })

    beforeEach(() => {
      logs.length = 0
    })

    afterAll(async () => {
      await server.stop({ timeout: 0 })
    })

    test('does not warn about missing configuration at start-up', () => {
      expect(startUpWarnings).toEqual([])
    })

    test('accepts a valid access token and gives routes the user and their roles', async () => {
      const token = await signAccessToken({
        claims: { roles: [roles.dataSteward, roles.dataOwner] }
      })

      const response = await callWithToken(
        server,
        '/test-only/credentials',
        token
      )

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.payload)).toEqual({
        user: {
          id: testUser.oid,
          displayName: testUser.name,
          email: testUser.preferred_username
        },
        scope: [roles.dataSteward, roles.dataOwner]
      })
      expect(logs).toEqual([])
    })

    test('accepts the Bearer scheme in lower case', async () => {
      const response = await callWithAuthorization(
        server,
        '/test-only/credentials',
        `bearer ${await signAccessToken()}`
      )

      expect(response.statusCode).toBe(200)
    })

    test('accepts a token issued for the api:// application ID URI', async () => {
      const token = await signAccessToken({ audience: `api://${CLIENT_ID}` })

      const response = await callWithToken(
        server,
        '/test-only/credentials',
        token
      )

      expect(response.statusCode).toBe(200)
    })

    test('accepts a token that grants the API scope among other scopes', async () => {
      const token = await signAccessToken({
        claims: { scp: 'User.Read access_as_user' }
      })

      const response = await callWithToken(
        server,
        '/test-only/credentials',
        token
      )

      expect(response.statusCode).toBe(200)
    })

    test('gives a user with no roles an empty role list', async () => {
      const token = await signAccessToken({ claims: { roles: undefined } })

      const response = await callWithToken(
        server,
        '/test-only/credentials',
        token
      )

      expect(JSON.parse(response.payload).scope).toEqual([])
    })

    test('ignores roles the service does not define', async () => {
      const token = await signAccessToken({
        claims: { roles: [roles.administrator, 'Unknown.Role', 42] }
      })

      const response = await callWithToken(
        server,
        '/test-only/credentials',
        token
      )

      expect(JSON.parse(response.payload).scope).toEqual([roles.administrator])
    })

    test('protects the example routes by default', async () => {
      const withoutToken = await server.inject({
        method: 'GET',
        url: '/example'
      })
      const withToken = await callWithToken(
        server,
        '/example',
        await signAccessToken()
      )

      expectMissingTokenResponse(withoutToken)
      expect(withToken.statusCode).toBe(200)
      expect(JSON.parse(withToken.payload)).toEqual([])
    })

    test('returns not found for an example that does not exist when signed in', async () => {
      const response = await callWithToken(
        server,
        '/example/unknown-example',
        await signAccessToken()
      )

      expect(response.statusCode).toBe(404)
    })

    test('keeps the health check open without a token', async () => {
      const response = await server.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.payload)).toEqual({ message: 'success' })
      expect(globalThis.fetchMock.requests()).toHaveLength(0)
    })

    test('refuses a signed-in user without the Administrator role', async () => {
      const token = await signAccessToken({
        claims: { roles: [roles.dataSteward] }
      })

      const response = await callWithToken(
        server,
        '/test-only/administration',
        token
      )

      expect(response.statusCode).toBe(403)
    })

    test('lets a signed-in Administrator use an Administrator route', async () => {
      const token = await signAccessToken({
        claims: { roles: [roles.administrator] }
      })

      const response = await callWithToken(
        server,
        '/test-only/administration',
        token
      )

      expect(response.statusCode).toBe(200)
    })

    test('does not treat a rejected token as an anonymous request on an optional sign-in route', async () => {
      const withoutToken = await server.inject({
        method: 'GET',
        url: '/test-only/optional-sign-in'
      })
      const withExpiredToken = await callWithToken(
        server,
        '/test-only/optional-sign-in',
        await signAccessToken({
          expiresAt: nowInSeconds() - FIVE_MINUTES_IN_SECONDS
        })
      )
      const withMalformedToken = await callWithToken(
        server,
        '/test-only/optional-sign-in',
        'not a-token'
      )

      expect(withoutToken.statusCode).toBe(200)
      expect(JSON.parse(withoutToken.payload)).toEqual({ signedIn: false })
      expectInvalidTokenResponse(withExpiredToken)
      expectInvalidTokenResponse(withMalformedToken)
    })

    describe('rejects a request with no bearer token', () => {
      test.each([
        ['there is no Authorization header', undefined],
        [
          'the Authorization header uses the Basic scheme',
          'Basic dGVzdDp0ZXN0'
        ],
        ['the Bearer scheme has no token', 'Bearer ']
      ])('when %s', async (_scenario, authorization) => {
        const response = await callWithAuthorization(
          server,
          '/test-only/credentials',
          authorization
        )

        expectMissingTokenResponse(response)
        expect(logs).toEqual([rejectedTokenLog('ERR_BEARER_TOKEN_MISSING')])
      })
    })

    describe('rejects a request with an unacceptable token', () => {
      const unacceptableTokens = [
        [
          'the bearer token contains a space',
          () => 'not a-token',
          'ERR_BEARER_TOKEN_MALFORMED'
        ],
        [
          'the bearer token contains characters a token cannot have',
          () => 'to%ken',
          'ERR_BEARER_TOKEN_MALFORMED'
        ],
        ['the token is not a JWT', () => 'not-a-jwt', 'ERR_JWS_INVALID'],
        [
          'the token is signed with a key Entra did not publish',
          () => signAccessToken({ key: unknownSigningKey }),
          'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'
        ],
        [
          'the token is signed with PS256 instead of RS256',
          () =>
            signAccessToken({
              algorithm: 'PS256',
              key: samePublicKeyWithPs256
            }),
          'ERR_JOSE_ALG_NOT_ALLOWED'
        ],
        [
          'the token is signed with HS256',
          () =>
            signAccessToken({ algorithm: 'HS256', key: new Uint8Array(32) }),
          'ERR_JOSE_ALG_NOT_ALLOWED'
        ],
        [
          'the token is unsigned (alg none)',
          () =>
            new UnsecuredJWT({ ...testUser, scp: 'access_as_user' })
              .setIssuer(ISSUER)
              .setAudience(CLIENT_ID)
              .setExpirationTime('5m')
              .encode(),
          'ERR_JOSE_ALG_NOT_ALLOWED'
        ],
        [
          'the token was issued by another tenant',
          () =>
            signAccessToken({
              issuer: `https://login.microsoftonline.com/${OTHER_GUID}/v2.0`
            }),
          'ERR_JWT_CLAIM_VALIDATION_FAILED: iss'
        ],
        [
          'the token is a v1.0 token',
          () =>
            signAccessToken({
              issuer: `https://sts.windows.net/${TENANT_ID}/`
            }),
          'ERR_JWT_CLAIM_VALIDATION_FAILED: iss'
        ],
        [
          'the token was issued for another application',
          () => signAccessToken({ audience: OTHER_GUID }),
          'ERR_JWT_CLAIM_VALIDATION_FAILED: aud'
        ],
        [
          'the token has expired',
          () =>
            signAccessToken({
              expiresAt: nowInSeconds() - FIVE_MINUTES_IN_SECONDS
            }),
          'ERR_JWT_EXPIRED: exp'
        ],
        [
          'the token is not valid yet',
          () =>
            signAccessToken({
              notBefore: nowInSeconds() + FIVE_MINUTES_IN_SECONDS
            }),
          'ERR_JWT_CLAIM_VALIDATION_FAILED: nbf'
        ],
        [
          'the token has no expiry',
          () =>
            new SignJWT({ ...testUser, scp: 'access_as_user' })
              .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
              .setIssuer(ISSUER)
              .setAudience(CLIENT_ID)
              .sign(signingKey),
          'ERR_JWT_CLAIM_VALIDATION_FAILED: exp'
        ],
        [
          'the token has no user object ID',
          () => signAccessToken({ claims: { oid: undefined } }),
          'ERR_JWT_CLAIM_VALIDATION_FAILED: oid'
        ],
        [
          'the token is an app-only token with no delegated scope',
          () =>
            signAccessToken({
              claims: { scp: undefined, roles: [roles.administrator] }
            }),
          'ERR_SCOPE_NOT_GRANTED'
        ],
        [
          'the token is an ID token rather than an access token',
          () =>
            signAccessToken({
              claims: { scp: undefined, roles: undefined, nonce: 'test-nonce' }
            }),
          'ERR_SCOPE_NOT_GRANTED'
        ],
        [
          'the token grants a different scope',
          () => signAccessToken({ claims: { scp: 'User.Read' } }),
          'ERR_SCOPE_NOT_GRANTED'
        ]
      ]

      test.each(unacceptableTokens)(
        'when %s',
        async (_scenario, buildToken, expectedReason) => {
          const response = await callWithToken(
            server,
            '/test-only/credentials',
            await buildToken()
          )

          expectInvalidTokenResponse(response)
          expect(logs).toEqual([rejectedTokenLog(expectedReason)])
        }
      )
    })

    test('logs why a token was rejected without the token or personal details', async () => {
      const token = await signAccessToken({
        audience: OTHER_GUID,
        claims: { roles: [roles.administrator] }
      })

      await callWithToken(server, '/test-only/credentials', token)

      const logged = JSON.stringify(logs)
      expect(logged).not.toContain(token)
      expect(logged).not.toContain(testUser.oid)
      expect(logged).not.toContain(testUser.name)
      expect(logged).not.toContain(testUser.preferred_username)
      expect(logged).not.toContain(OTHER_GUID)
    })
  })

  describe('When the signing keys cannot be fetched', () => {
    let server
    let logs

    beforeAll(async () => {
      server = await createTestServer(configuredEnv)
      logs = captureRequestLogs(server)
      await server.initialize()
    })

    beforeEach(() => {
      logs.length = 0
    })

    afterAll(async () => {
      await server.stop({ timeout: 0 })
    })

    test.each([
      [
        'Entra returns an error',
        () => globalThis.fetchMock.mockResponse({ status: 503, body: '' }),
        'ERR_JOSE_GENERIC',
        {
          type: 'JOSEError',
          message: 'Expected 200 OK from the JSON Web Key Set HTTP response'
        }
      ],
      [
        'Entra returns something that is not a key set',
        () =>
          globalThis.fetchMock.mockResponse({
            body: JSON.stringify({ keys: 'not-a-key-list' })
          }),
        'ERR_JWKS_INVALID',
        { type: 'JWKSInvalid', message: 'JSON Web Key Set malformed' }
      ],
      [
        'Entra cannot be reached',
        () =>
          globalThis.fetchMock.mockReject(
            new TypeError('fetch failed', {
              cause: { code: 'ECONNREFUSED' }
            })
          ),
        'TypeError',
        { type: 'TypeError', message: 'fetch failed', code: 'ECONNREFUSED' }
      ]
    ])(
      'rejects a valid token with a 401 and logs an error when %s',
      async (_scenario, breakSigningKeys, expectedReason, expectedError) => {
        breakSigningKeys()

        const response = await callWithToken(
          server,
          '/test-only/credentials',
          await signAccessToken()
        )

        expectInvalidTokenResponse(response)
        expect(logs).toEqual([
          {
            level: 'error',
            args: [
              {
                event: {
                  category: ['authentication'],
                  outcome: 'failure',
                  reason: expectedReason
                },
                error: expectedError
              },
              'Access token could not be verified'
            ]
          }
        ])
      }
    )
  })

  describe('When Microsoft Entra ID is not configured', () => {
    let server
    let logs
    let startUpWarnings

    beforeAll(async () => {
      serveSigningKeys()
      server = await createTestServer(unconfiguredEnv)
      logs = captureRequestLogs(server)
      startUpWarnings = await initialiseAndRecordStartUpWarnings(server)
    })

    afterAll(async () => {
      await server.stop({ timeout: 0 })
    })

    test('warns once at start-up that protected routes will refuse every request', () => {
      expect(startUpWarnings).toEqual([
        [
          'Microsoft Entra ID is not configured (ENTRA_TENANT_ID, ENTRA_CLIENT_ID): every protected route will return 401'
        ]
      ])
    })

    test('rejects a well-formed token on a protected route without calling Entra', async () => {
      const response = await callWithToken(
        server,
        '/example',
        await signAccessToken()
      )

      expectInvalidTokenResponse(response)
      expect(globalThis.fetchMock.requests()).toHaveLength(0)
      expect(logs).toEqual([rejectedTokenLog('ERR_AUTH_NOT_CONFIGURED')])
    })

    test('keeps the health check open', async () => {
      const response = await server.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
    })
  })
})
