import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const globalForDb = globalThis as unknown as {
  pgClient: ReturnType<typeof postgres> | undefined
}



const connectionString =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'

const client = globalForDb.pgClient ?? postgres(connectionString, { max: 5 })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client
}

export const db = drizzle(client)
