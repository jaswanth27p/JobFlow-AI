#!/usr/bin/env bun
// Truncates all Postgres tables and flushes Redis. Local dev reset only.
import { sql } from 'drizzle-orm'
import { getDb, closeDb } from '../src/db/index.ts'

const TABLES = [
  'applications',
  'answer_reviews',
  'career_page_scans',
  'career_pages',
  'search_runs',
  'jobs',
] as const

async function clearDb(): Promise<void> {
  const db = getDb()
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`))
  await closeDb()
  console.log(`Postgres: truncated ${TABLES.length} tables`)
}

async function clearRedis(): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', 'exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`redis-cli FLUSHALL failed (exit ${code}): ${err || out}`)
  }
  console.log('Redis: flushed')
}

await clearDb()
await clearRedis()
console.log('Done.')
