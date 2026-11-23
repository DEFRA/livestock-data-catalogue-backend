# livestock-data-catalogue-backend

[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=DEFRA_livestock-data-catalogue-backend&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=DEFRA_livestock-data-catalogue-backend)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=DEFRA_livestock-data-catalogue-backend&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=DEFRA_livestock-data-catalogue-backend)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=DEFRA_livestock-data-catalogue-backend&metric=coverage)](https://sonarcloud.io/summary/new_code?id=DEFRA_livestock-data-catalogue-backend)

Core delivery platform Node.js Backend Template.

- [Requirements](#requirements)
  - [Node.js](#nodejs)
- [Local development](#local-development)
  - [Setup](#setup)
  - [Development](#development)
  - [Testing](#testing)
  - [Production](#production)
  - [Npm scripts](#npm-scripts)
  - [Update dependencies](#update-dependencies)
  - [Formatting](#formatting)
    - [Windows prettier issue](#windows-prettier-issue)
- [API endpoints](#api-endpoints)
- [Authentication](#authentication)
  - [What the service checks](#what-the-service-checks)
  - [Roles](#roles)
  - [Environment variables](#environment-variables)
  - [App Registration settings](#app-registration-settings)
  - [Running locally](#running-locally)
  - [Calling Entra through the CDP proxy](#calling-entra-through-the-cdp-proxy)
- [Development helpers](#development-helpers)
  - [MongoDB Locks](#mongodb-locks)
  - [Proxy](#proxy)
- [Docker](#docker)
  - [Development image](#development-image)
  - [Production image](#production-image)
  - [Docker Compose](#docker-compose)
  - [Dependabot](#dependabot)
  - [SonarCloud](#sonarcloud)
- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Requirements

### Node.js

Please install [Node.js](http://nodejs.org/) `>= v24` and [npm](https://nodejs.org/) `>= v11`. You will find it
easier to use the Node Version Manager [nvm](https://github.com/creationix/nvm)

To use the correct version of Node.js for this application, via nvm:

```bash
cd livestock-data-catalogue-backend
nvm use
```

## Local development

### Setup

Install application dependencies:

```bash
npm install
```

### Git hooks

Install git hooks (optional)

```bash
npm run git:hooks
```

### Development

To run the application in `development` mode run:

```bash
npm run dev
```

### Testing

To test the application run:

```bash
npm run test
```

### Production

To mimic the application running in `production` mode locally run:

```bash
npm start
```

### Npm scripts

All available Npm scripts can be seen in [package.json](./package.json).
To view them in your command line run:

```bash
npm run
```

### Update dependencies

To update dependencies use [npm-check-updates](https://github.com/raineorshine/npm-check-updates):

> The following script is a good start. Check out all the options on
> the [npm-check-updates](https://github.com/raineorshine/npm-check-updates)

```bash
ncu --interactive --format group
```

### Formatting

#### Windows prettier issue

If you are having issues with formatting of line breaks on Windows update your global git config by running:

```bash
git config --global core.autocrlf false
```

## API endpoints

| Endpoint             | Description                    | Authentication          |
| :------------------- | :----------------------------- | :---------------------- |
| `GET: /health`       | Health                         | None (CDP health check) |
| `GET: /example    `  | Example API (remove as needed) | Entra ID access token   |
| `GET: /example/<id>` | Example API (remove as needed) | Entra ID access token   |

## Authentication

Every route needs a Microsoft Entra ID access token unless it opts out with `options: { auth: false }`.
Only `GET /health` opts out, so that CDP's container health check works.

The Livestock Data Catalogue frontend signs the user in with Entra ID. It then sends the user's access token
on each call to this service:

```http
Authorization: Bearer <access token>
```

The `entra-id` auth strategy in [src/plugins/auth.js](./src/plugins/auth.js) is the server's default strategy.
It uses [jose](https://github.com/panva/jose) to check the token, following the CDP pattern in
[cdp-user-service-backend](https://github.com/DEFRA/cdp-user-service-backend/blob/main/src/helpers/azure-oidc.js).

### What the service checks

A request is refused with `401 Unauthorized` unless all of these are true:

- the `Authorization` header uses the `Bearer` scheme
- the token is signed with `RS256` by a key published at
  `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys`. Any other algorithm, including `HS256`
  and unsigned (`none`) tokens, is refused
- the issuer (`iss`) is `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0`, so only v2.0 tokens from our tenant are accepted
- the audience (`aud`) is `<ENTRA_CLIENT_ID>` or `api://<ENTRA_CLIENT_ID>`
- the token has an expiry (`exp`) that has not passed and, if it has a not-before time (`nbf`), that time has
  been reached (15 seconds of clock tolerance)
- the token has a user object ID (`oid`)
- the delegated scopes (`scp`) include `ENTRA_API_SCOPE`. App-only tokens have no `scp` claim, so they are refused

There are only 2 kinds of refusal, so callers can't tell why their token was refused:

| Request                                      | `WWW-Authenticate` header      | Body `message`           |
| :------------------------------------------- | :----------------------------- | :----------------------- |
| No `Authorization: Bearer <token>` header    | `Bearer`                       | `Missing authentication` |
| A token that fails any check, for any reason | `Bearer error="invalid_token"` | `invalid_token`          |

A route with `auth: { mode: 'optional' }` treats a request with no token as anonymous, but still refuses an invalid token.
Do not use `auth: { mode: 'try' }`: Hapi then runs the handler even when the token is invalid. If you must use it,
check `request.auth.isAuthenticated` in the handler.

The service logs the reason (for example `ERR_JWT_EXPIRED: exp`) as an ECS `event.reason`:

- at `warn` with the message `Access token rejected` when the token is at fault
- at `error` with the message `Access token could not be verified` when Entra's signing keys could not be
  fetched, for example because the proxy is misconfigured. Alert on this message

Logs never contain the token or its claims. The token's name, email address and object ID are personal data.

When the token is accepted, routes get these credentials:

```javascript
request.auth.credentials = {
  user: {
    id: '<oid claim>',
    displayName: '<name claim>',
    email: '<preferred_username claim>'
  },
  scope: ['DataSteward'] // the user's app roles, or [] if they have none
}
```

Use `user.id` (the Entra object ID) whenever you need to identify a user, for example to record who owns something.
`email` is the user's sign-in name. It can change or be reused, so use it for display only.

Any signed-in user in the tenant who can get a token for this API can call a route that has no role check.
Use [roles](#roles) to restrict a route, and see "Assignment required" under [App Registration settings](#app-registration-settings).

### Roles

The App Registration defines the app roles `Administrator`, `DataSteward` and `DataOwner`.
Their names are kept in [src/common/constants/roles.js](./src/common/constants/roles.js).
Roles in the token that are not on this list are ignored.

Restrict a route to a role with Hapi's `auth.access.scope`. A signed-in user without the role gets `403 Forbidden`:

```javascript
import { roles } from '#/common/constants/roles.js'

export const exampleAdminRoute = {
  method: 'GET',
  path: '/admin/example',
  options: {
    auth: { access: { scope: [roles.administrator] } }
  },
  handler: () => ({ message: 'success' })
}
```

### Environment variables

| Name              | Purpose                                                                                   | Default          | Required                       |
| :---------------- | :---------------------------------------------------------------------------------------- | :--------------- | :----------------------------- |
| `ENTRA_TENANT_ID` | Directory (tenant) ID of the Entra tenant that issues the tokens (a GUID)                 | empty            | Yes when `NODE_ENV=production` |
| `ENTRA_CLIENT_ID` | Application (client) ID of the App Registration shared with the frontend (a GUID)         | empty            | Yes when `NODE_ENV=production` |
| `ENTRA_API_SCOPE` | Delegated scope the token must grant, as it appears in the `scp` claim (not the full URI) | `access_as_user` | No                             |

These values are identifiers, not secrets. Set them per environment in
[cdp-app-config](https://github.com/DEFRA/cdp-app-config), not as CDP Portal secrets.

The service will not start when `NODE_ENV` is `production` and `ENTRA_TENANT_ID` or `ENTRA_CLIENT_ID` is not set.
The CDP container image runs in production mode in every CDP environment, so all CDP environments need both values.
A value that is not a GUID, or a scope name with spaces, also stops the service from starting.

### App Registration settings

The service relies on these settings on the App Registration. Check them when you set up a new environment:

- **Expose an API**: the Application ID URI is `api://<client ID>`, and it has a delegated scope named
  `ENTRA_API_SCOPE` (`access_as_user` by default)
- **Access token version 2**: in the manifest, `api.requestedAccessTokenVersion` is `2`
  (`accessTokenAcceptedVersion` in the older manifest format). Version 1 tokens have a different issuer and are refused
- **App roles**: `Administrator`, `DataSteward` and `DataOwner`, allowed for users or groups, with these exact values.
  Assign them under the Enterprise Application. Entra then puts the user's roles in the access token's `roles` claim
- **Frontend sign-in**: the frontend asks for the scope `api://<client ID>/<ENTRA_API_SCOPE>`, together with `openid` and
  `profile`, so that the access token has the `name` and `preferred_username` claims
- **Assignment required** (required in every environment): set "Assignment required" to Yes on the Enterprise
  Application, so only users or groups assigned to the app can get a token for this API. Until routes require a role
  by default, this is what limits who can call routes that have no role check

### Running locally

There is no local sign-in yet. If `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` are not set, which is the default
for `npm run dev`, the service:

- logs one warning when it starts: `Microsoft Entra ID is not configured ...`
- returns `401` for every protected route, including the example routes
- still answers `GET /health`

This fails closed: nothing is open just because the configuration is missing.

### Calling Entra through the CDP proxy

The service fetches Entra's signing keys from `login.microsoftonline.com` with Node's built-in `fetch`.
That domain is on CDP's default proxy allow list, so the service needs no allow-list change.

On CDP, outbound calls must go through the platform proxy. Node's `fetch` uses the proxy only when these variables are
set. Add them to the service's `default.env` (or a per-environment file) in
[cdp-app-config](https://github.com/DEFRA/cdp-app-config), as described in the
[CDP proxy guide](https://github.com/DEFRA/cdp-documentation/blob/main/how-to/proxy.md#using-the-proxy-in-your-node-service):

```bash
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://localhost:3128
NO_PROXY=.cdp-int.defra.cloud,.s3.eu-west-2.amazonaws.com,sqs.eu-west-2.amazonaws.com,sns.eu-west-2.amazonaws.com,dynamodb.eu-west-2.amazonaws.com
```

Without them, the signing keys can't be fetched and every protected route returns `401`. The service then logs
`Access token could not be verified` at `error`.

## Development helpers

### MongoDB Locks

If you require a write lock for Mongo you can acquire it via `server.locker` or `request.locker`:

```javascript
async function doStuff(server) {
  const lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  try {
    // do stuff
  } finally {
    await lock.free()
  }
}
```

Keep it small and atomic.

You may use **using** for the lock resource management.
Note test coverage reports do not like that syntax.

```javascript
async function doStuff(server) {
  await using lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  // do stuff

  // lock automatically released
}
```

Helper methods are also available in `/src/helpers/mongo-lock.js`.

### Proxy

We are using forward-proxy which is set up by default. Services are automatically configured with the `HTTP_PROXY`
environment variable when deployed.

Node.js 24 routes outbound HTTP(S) requests, including `fetch`, through the proxy only when these variables are set
in [cdp-app-config](https://github.com/DEFRA/cdp-app-config):

```bash
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://localhost:3128
NO_PROXY=...
```

See [Calling Entra through the CDP proxy](#calling-entra-through-the-cdp-proxy) for the values this service needs.

## Docker

Build:

```bash
docker build --no-cache --tag livestock-data-catalogue-backend .
```

Run:

```bash
docker run -e PORT=3001 -p 3001:3001 livestock-data-catalogue-backend
```

### Docker Compose

A local environment with:

- Floci for AWS services (S3, SQS, SNS etc)
- Redis
- MongoDB
- This service.
- A commented out frontend example.

```bash
docker compose up --build -d
```

Mock AWS resources can be created when Floci starts up by editing the scripts in `./compose/floci/start.d/`.
MongoDB records can also be created when Mongo starts by editing the scripts in `./compose/mongo/`.

### Dependabot

We have added an example dependabot configuration file to the repository. You can enable it by renaming
the [.github/example.dependabot.yml](.github/example.dependabot.yml) to `.github/dependabot.yml`

### SonarCloud

SonarCloud analyses pull requests from this repository and every push to
`main`. See the
[project dashboard](https://sonarcloud.io/summary/new_code?id=DEFRA_livestock-data-catalogue-backend).

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government license v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
