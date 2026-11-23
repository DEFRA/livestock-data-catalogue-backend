const GUID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

// A single delegated scope value, such as `access_as_user`. Spaces are not
// allowed because the token's `scp` claim is a space-separated list.
const SCOPE_NAME_PATTERN = /^[\w.-]+$/

// Tenant and client IDs are built into the issuer and keys URLs, so only a
// plain GUID is accepted. Empty means "not configured" outside production.
export const convictValidateOptionalGuid = {
  name: 'optional-guid',
  validate: function validateOptionalGuid(value) {
    if (value !== '' && !GUID_PATTERN.test(value)) {
      throw new Error('must be a GUID or empty')
    }
  }
}

export const convictValidateScopeName = {
  name: 'scope-name',
  validate: function validateScopeName(value) {
    if (typeof value !== 'string' || !SCOPE_NAME_PATTERN.test(value)) {
      throw new Error(
        'must be a single scope name using letters, digits, ".", "_" or "-"'
      )
    }
  }
}
