import { Db, MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

describe('#mongoDb', () => {
  let server

  describe('Set up', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Server should have expected MongoDb decorators', () => {
      expect(server.db).toBeInstanceOf(Db)
      expect(server.mongoClient).toBeInstanceOf(MongoClient)
      expect(server.locker).toBeInstanceOf(LockManager)
    })

    test('MongoDb should have expected database name', () => {
      expect(server.db.databaseName).toBe('livestock-data-catalogue-backend')
    })

    test('MongoDb should have expected namespace', () => {
      expect(server.db.namespace).toBe('livestock-data-catalogue-backend')
    })

    test('Should expose the mongo-locks ready promise awaited at start-up', () => {
      expect(server.locker.ready).toBeInstanceOf(Promise)
    })

    test('Should create the lock indexes before the server is ready', async () => {
      const indexes = await server.db.collection('mongo-locks').indexes()

      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: { action: 1 }, unique: true }),
          expect.objectContaining({
            key: { expiresAt: 1 },
            expireAfterSeconds: 0
          })
        ])
      )
    })
  })

  describe('Shut down', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Should close Mongo client on server stop', async () => {
      const closeSpy = vi.spyOn(server.mongoClient, 'close')
      await server.stop({ timeout: 1000 })

      expect(closeSpy).toHaveBeenCalledWith(true)
    })
  })

  describe('When the lock indexes cannot be built', () => {
    afterEach(() => {
      vi.doUnmock('mongo-locks')
      vi.restoreAllMocks()
      vi.resetModules()
    })

    test('Should fail start-up', async () => {
      vi.resetModules()
      vi.doMock('mongo-locks', () => ({
        LockManager: class {
          ready = Promise.reject(new Error('index build failed'))
        }
      }))
      const mongodb = await import('mongodb')
      vi.spyOn(mongodb.MongoClient, 'connect').mockResolvedValue({
        db: () => ({ collection: () => ({}) })
      })
      const { default: hapi } = await import('@hapi/hapi')
      const { mongoDb } = await import('#/plugins/mongodb.js')

      const failingServer = hapi.server()
      failingServer.decorate('server', 'logger', { info: vi.fn() })

      await expect(
        failingServer.register({
          plugin: mongoDb.plugin,
          options: { mongoUrl: 'mongodb://unused', databaseName: 'test' }
        })
      ).rejects.toThrow('index build failed')
    })
  })
})
