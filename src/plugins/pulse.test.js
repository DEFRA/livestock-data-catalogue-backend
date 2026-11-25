import { createRequire } from 'node:module'

describe('#pulse', () => {
  test('hapi-pulse checks its options with the same joi as the service', () => {
    const require = createRequire(import.meta.url)
    const requireFromPulse = createRequire(require.resolve('hapi-pulse'))

    expect(requireFromPulse.resolve('joi')).toBe(require.resolve('joi'))
  })
})
