export const health = {
  method: 'GET',
  path: '/health',
  options: {
    // CDP's container health check calls this without a token
    auth: false
  },
  handler: (_request, h) => h.response({ message: 'success' })
}
