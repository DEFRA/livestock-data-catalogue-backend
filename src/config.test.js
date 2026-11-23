const TENANT_ID = '11111111-2222-4333-8444-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function loadConfig(env) {
  vi.resetModules()
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value)
  }
  const { config } = await import('#/config.js')
  return config
}

describe('#config Microsoft Entra ID settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('refuses to start in production without a tenant ID or client ID', async () => {
    await expect(
      loadConfig({
        NODE_ENV: 'production',
        ENTRA_TENANT_ID: '',
        ENTRA_CLIENT_ID: ''
      })
    ).rejects.toThrow(
      'Microsoft Entra ID is not configured: set ENTRA_TENANT_ID and ENTRA_CLIENT_ID'
    )
  })

  test('refuses to start in production without a client ID', async () => {
    await expect(
      loadConfig({
        NODE_ENV: 'production',
        ENTRA_TENANT_ID: TENANT_ID,
        ENTRA_CLIENT_ID: ''
      })
    ).rejects.toThrow(
      'Microsoft Entra ID is not configured: set ENTRA_CLIENT_ID'
    )
  })

  test('refuses to start in production without a tenant ID', async () => {
    await expect(
      loadConfig({
        NODE_ENV: 'production',
        ENTRA_TENANT_ID: '',
        ENTRA_CLIENT_ID: CLIENT_ID
      })
    ).rejects.toThrow(
      'Microsoft Entra ID is not configured: set ENTRA_TENANT_ID'
    )
  })

  test('starts in production when the tenant ID and client ID are set', async () => {
    const config = await loadConfig({
      NODE_ENV: 'production',
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_CLIENT_ID: CLIENT_ID
    })

    expect(config.get('entra')).toEqual({
      authorityUrl: 'https://login.microsoftonline.com',
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      apiScope: 'access_as_user'
    })
  })

  test('allows the tenant ID and client ID to be empty outside production', async () => {
    const config = await loadConfig({
      NODE_ENV: 'development',
      ENTRA_TENANT_ID: '',
      ENTRA_CLIENT_ID: ''
    })

    expect(config.get('entra.tenantId')).toBe('')
    expect(config.get('entra.clientId')).toBe('')
  })

  test('uses the API scope name from the environment', async () => {
    const config = await loadConfig({ ENTRA_API_SCOPE: 'catalogue.read' })

    expect(config.get('entra.apiScope')).toBe('catalogue.read')
  })

  test.each([
    [
      'ENTRA_TENANT_ID',
      'not-a-guid',
      'entra.tenantId: must be a GUID or empty'
    ],
    [
      'ENTRA_TENANT_ID',
      `${TENANT_ID}/../evil`,
      'entra.tenantId: must be a GUID or empty'
    ],
    [
      'ENTRA_CLIENT_ID',
      'not-a-guid',
      'entra.clientId: must be a GUID or empty'
    ],
    ['ENTRA_API_SCOPE', '', 'entra.apiScope: must be a single scope name'],
    [
      'ENTRA_API_SCOPE',
      'access_as_user other_scope',
      'entra.apiScope: must be a single scope name'
    ]
  ])(
    'refuses to start when %s is set to %j',
    async (name, value, expectedError) => {
      await expect(loadConfig({ [name]: value })).rejects.toThrow(expectedError)
    }
  )
})
