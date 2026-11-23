// App roles defined on the Microsoft Entra ID App Registration. The values
// must match the role values there exactly, because Entra puts them in the
// access token's `roles` claim and routes check them with `auth.access.scope`.
export const roles = Object.freeze({
  administrator: 'Administrator',
  dataSteward: 'DataSteward',
  dataOwner: 'DataOwner'
})
