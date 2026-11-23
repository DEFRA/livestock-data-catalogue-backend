import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from '#/common/helpers/convict/validate-mongo-uri.js'
import {
  convictValidateOptionalGuid,
  convictValidateScopeName
} from '#/common/helpers/convict/entra-formats.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormat(convictValidateOptionalGuid)
convict.addFormat(convictValidateScopeName)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

export const config = convict({
  serviceVersion: {
    doc: 'The service version, this variable is injected into your docker container in CDP environments',
    format: String,
    nullable: true,
    default: null,
    env: 'SERVICE_VERSION'
  },
  host: {
    doc: 'The IP address to bind',
    format: 'ipaddress',
    default: '0.0.0.0',
    env: 'HOST'
  },
  port: {
    doc: 'The port to bind',
    format: 'port',
    default: 3001,
    env: 'PORT'
  },
  serviceName: {
    doc: 'Api Service Name',
    format: String,
    default: 'livestock-data-catalogue-backend'
  },
  cdpEnvironment: {
    doc: 'The CDP environment the app is running in. With the addition of "local" for local development',
    format: [
      'local',
      'infra-dev',
      'management',
      'dev',
      'test',
      'perf-test',
      'ext-test',
      'prod'
    ],
    default: 'local',
    env: 'ENVIRONMENT'
  },
  log: {
    isEnabled: {
      doc: 'Is logging enabled',
      format: Boolean,
      default: !isTest,
      env: 'LOG_ENABLED'
    },
    level: {
      doc: 'Logging level',
      format: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
      env: 'LOG_LEVEL'
    },
    format: {
      doc: 'Format to output logs in',
      format: ['ecs', 'pino-pretty'],
      default: isProduction ? 'ecs' : 'pino-pretty',
      env: 'LOG_FORMAT'
    },
    redact: {
      doc: 'Log paths to redact',
      format: Array,
      default: isProduction
        ? ['req.headers.authorization', 'req.headers.cookie', 'res.headers']
        : ['req', 'res', 'responseTime']
    }
  },
  mongo: {
    mongoUrl: {
      doc: 'URI for mongodb',
      format: String,
      default: 'mongodb://127.0.0.1:27017/',
      env: 'MONGO_URI'
    },
    databaseName: {
      doc: 'database for mongodb',
      format: String,
      default: 'livestock-data-catalogue-backend',
      env: 'MONGO_DATABASE'
    },
    mongoOptions: {
      retryWrites: {
        doc: 'Enable Mongo write retries, overrides mongo URI when set.',
        format: Boolean,
        default: null,
        nullable: true,
        env: 'MONGO_RETRY_WRITES'
      },
      readPreference: {
        doc: 'Mongo read preference, overrides mongo URI when set.',
        format: [
          'primary',
          'primaryPreferred',
          'secondary',
          'secondaryPreferred',
          'nearest'
        ],
        default: null,
        nullable: true,
        env: 'MONGO_READ_PREFERENCE'
      }
    }
  },
  httpProxy: {
    doc: 'HTTP Proxy URL',
    format: String,
    nullable: true,
    default: null,
    env: 'HTTP_PROXY'
  },
  tracing: {
    header: {
      doc: 'CDP tracing header name',
      format: String,
      default: 'x-cdp-request-id',
      env: 'TRACING_HEADER'
    }
  },
  entra: {
    authorityUrl: {
      doc: 'Microsoft Entra ID sign-in authority (public cloud). The token issuer and signing keys URL are built from it and the tenant ID',
      format: 'url',
      default: 'https://login.microsoftonline.com'
    },
    tenantId: {
      doc: 'Microsoft Entra ID tenant (directory) ID that issues access tokens. Required in production',
      format: 'optional-guid',
      default: '',
      env: 'ENTRA_TENANT_ID'
    },
    clientId: {
      doc: 'Application (client) ID of the App Registration that exposes this API. Required in production',
      format: 'optional-guid',
      default: '',
      env: 'ENTRA_CLIENT_ID'
    },
    apiScope: {
      doc: 'Delegated scope the access token must grant (the `scp` claim)',
      format: 'scope-name',
      default: 'access_as_user',
      env: 'ENTRA_API_SCOPE'
    }
  }
})

config.validate({ allowed: 'strict' })

if (isProduction) {
  assertEntraIdConfigured()
}

// Without these, every protected route returns 401. That is safe, but in
// production it means a broken service, so refuse to start instead.
function assertEntraIdConfigured() {
  const missingVariables = [
    ['ENTRA_TENANT_ID', config.get('entra.tenantId')],
    ['ENTRA_CLIENT_ID', config.get('entra.clientId')]
  ]
    .filter(([, value]) => value === '')
    .map(([name]) => name)

  if (missingVariables.length > 0) {
    throw new Error(
      `Microsoft Entra ID is not configured: set ${missingVariables.join(' and ')}. They are required when NODE_ENV is production`
    )
  }
}
