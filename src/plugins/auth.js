import Boom from '@hapi/boom'
import { errors as joseErrors } from 'jose'

import {
  AccessTokenRejected,
  createEntraAccessTokenVerifier
} from '#/common/helpers/auth/entra-access-token.js'

// RFC 6750 bearer token characters. The two quantified parts cannot overlap,
// so the pattern cannot backtrack catastrophically.
// The Bearer scheme followed by something: a bare "Bearer" sends no token
const BEARER_SCHEME_PATTERN = /^Bearer\s+\S/i
const BEARER_TOKEN_PATTERN = /^Bearer ([\w\-.~+/]+=*)$/i
const INVALID_TOKEN = 'invalid_token'

// These mean Entra's signing keys could not be fetched, not that the token is bad
const SIGNING_KEYS_UNAVAILABLE_CODES = new Set([
  'ERR_JOSE_GENERIC',
  'ERR_JWKS_TIMEOUT',
  'ERR_JWKS_INVALID'
])

export const entraAuth = {
  plugin: {
    name: 'entra-auth',
    register: (server, options) => {
      const configured = options.tenantId !== '' && options.clientId !== ''
      const verifyAccessToken = configured
        ? createEntraAccessTokenVerifier(options)
        : rejectEveryToken

      if (!configured) {
        server.ext('onPreStart', () => {
          server.logger.warn(
            'Microsoft Entra ID is not configured (ENTRA_TENANT_ID, ENTRA_CLIENT_ID): every protected route will return 401'
          )
        })
      }

      server.auth.scheme('entra-access-token', () => ({
        authenticate: async (request, h) => {
          const authorizationHeader = request.headers.authorization

          if (!usesBearerScheme(authorizationHeader)) {
            logRejection(
              request,
              new AccessTokenRejected('ERR_BEARER_TOKEN_MISSING')
            )
            // No message: Hapi treats this as "no credentials"
            throw Boom.unauthorized(null, 'Bearer')
          }

          try {
            const token = readBearerToken(authorizationHeader)
            const credentials = await verifyAccessToken(token)
            return h.authenticated({ credentials })
          } catch (error) {
            logRejection(request, error)
            // A token was sent but is not acceptable. Reporting it as invalid,
            // not missing, stops an `optional` auth route treating it as an
            // anonymous request. The RFC 6750 code never reveals the reason.
            throw Boom.unauthorized(INVALID_TOKEN, 'Bearer')
          }
        }
      }))
      server.auth.strategy('entra-id', 'entra-access-token')
      server.auth.default('entra-id')
    }
  }
}

function rejectEveryToken() {
  throw new AccessTokenRejected('ERR_AUTH_NOT_CONFIGURED')
}

function usesBearerScheme(authorizationHeader) {
  return (
    typeof authorizationHeader === 'string' &&
    BEARER_SCHEME_PATTERN.test(authorizationHeader)
  )
}

function readBearerToken(authorizationHeader) {
  const match = BEARER_TOKEN_PATTERN.exec(authorizationHeader)

  if (!match) {
    throw new AccessTokenRejected('ERR_BEARER_TOKEN_MALFORMED')
  }

  return match[1]
}

function logRejection(request, error) {
  const event = {
    category: ['authentication'],
    outcome: 'failure',
    reason: describeReason(error)
  }

  if (isTokenProblem(error)) {
    request.logger.warn({ event }, 'Access token rejected')
  } else {
    // Not a token problem, so the error holds no claims. Its details help
    // diagnose proxy or network faults when fetching the signing keys.
    request.logger.error(
      {
        event,
        error: {
          type: error.name,
          message: error.message,
          code: error.cause?.code
        }
      },
      'Access token could not be verified'
    )
  }
}

function isTokenProblem(error) {
  return (
    (error instanceof AccessTokenRejected ||
      error instanceof joseErrors.JOSEError) &&
    !SIGNING_KEYS_UNAVAILABLE_CODES.has(error.code)
  )
}

// Log only the error code and claim name. jose errors also carry the token's
// claims, which hold personal data (name, email, object ID).
function describeReason(error) {
  if (!error.code) {
    return error.name
  }
  return error.claim ? `${error.code}: ${error.claim}` : error.code
}
