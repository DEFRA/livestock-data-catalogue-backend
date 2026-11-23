import { createRemoteJWKSet, jwtVerify } from 'jose'

import { roles } from '#/common/constants/roles.js'

// Entra signs access tokens with RS256. Allowing only that algorithm stops
// algorithm-confusion attacks, such as HS256 or unsigned (`none`) tokens.
const ALLOWED_ALGORITHMS = ['RS256']
const CLOCK_TOLERANCE_SECONDS = 15
const SIGNING_KEYS_TIMEOUT_MS = 5000
const KNOWN_ROLES = new Set(Object.values(roles))

export class AccessTokenRejected extends Error {
  constructor(code) {
    super('Access token rejected')
    this.name = 'AccessTokenRejected'
    this.code = code
  }
}

/**
 * Builds a function that verifies a Microsoft Entra ID v2.0 access token and
 * returns Hapi credentials. It throws if the token is not acceptable.
 * @param {{ authorityUrl: string, tenantId: string, clientId: string, apiScope: string }} settings
 * @returns {(token: string) => Promise<{ user: object, scope: string[] }>}
 */
export function createEntraAccessTokenVerifier({
  authorityUrl,
  tenantId,
  clientId,
  apiScope
}) {
  const tenantAuthority = `${authorityUrl}/${tenantId}`
  // jose caches the keys and refetches them when Entra rotates its signing key
  const signingKeys = createRemoteJWKSet(
    new URL(`${tenantAuthority}/discovery/v2.0/keys`),
    { timeoutDuration: SIGNING_KEYS_TIMEOUT_MS }
  )
  const verifyOptions = {
    algorithms: ALLOWED_ALGORITHMS,
    issuer: `${tenantAuthority}/v2.0`,
    audience: [clientId, `api://${clientId}`],
    requiredClaims: ['exp', 'oid'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS
  }

  return async function verifyEntraAccessToken(token) {
    const { payload } = await jwtVerify(token, signingKeys, verifyOptions)

    // App-only tokens have no `scp` claim, so they are refused here
    if (!grantsScope(payload.scp, apiScope)) {
      throw new AccessTokenRejected('ERR_SCOPE_NOT_GRANTED')
    }

    return toCredentials(payload)
  }
}

function grantsScope(scopeClaim, requiredScope) {
  return (
    typeof scopeClaim === 'string' &&
    scopeClaim.split(' ').includes(requiredScope)
  )
}

// Use `user.id` (the Entra object ID) to identify a user, for example for
// ownership checks. `email` is the sign-in name: it can change or be reused.
function toCredentials(payload) {
  return {
    user: {
      id: payload.oid,
      displayName: payload.name,
      email: payload.preferred_username
    },
    scope: knownRoles(payload.roles)
  }
}

function knownRoles(rolesClaim) {
  return Array.isArray(rolesClaim)
    ? rolesClaim.filter((role) => KNOWN_ROLES.has(role))
    : []
}
