/**
 * Test-only helpers (imported by *.test.ts; not used at runtime).
 *
 * `mockDb` is a tiny chainable stand-in for the supabase-js query builder: it
 * records every call (table, kind, filters, payload, terminal) and resolves to
 * whatever the injected `router` returns. Mirrors the mock in
 * apps/worker-analyse/src/run.test.ts, plus `.maybeSingle()`/`.single()`.
 */

import type { Db } from '@goodfor/db'

export interface RecordedOp {
  table: string
  kind: 'select' | 'insert' | 'update' | 'upsert'
  payload?: any
  opts?: any
  select?: string
  filters: [string, string, unknown][]
  terminal?: 'then' | 'maybeSingle' | 'single'
}

export type Router = (op: RecordedOp) => { data?: any; error?: any } | void

export function mockDb(router: Router = () => ({})): { client: Db; calls: RecordedOp[] } {
  const calls: RecordedOp[] = []

  function builder(table: string) {
    const op: RecordedOp = { table, kind: 'select', filters: [] }
    let pushed = false
    const settle = () => {
      if (!pushed) {
        calls.push(op)
        pushed = true
      }
      return { data: null, error: null, ...(router(op) ?? {}) }
    }

    const q: any = {}
    q.select = (sel?: string) => {
      op.select = sel
      return q
    }
    q.insert = (p: any) => {
      op.kind = 'insert'
      op.payload = p
      return q
    }
    q.update = (p: any) => {
      op.kind = 'update'
      op.payload = p
      return q
    }
    q.upsert = (p: any, o?: any) => {
      op.kind = 'upsert'
      op.payload = p
      op.opts = o
      return q
    }
    for (const m of ['eq', 'neq', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte'] as const) {
      q[m] = (col: string, val: unknown) => {
        op.filters.push([m, col, val])
        return q
      }
    }
    q.order = () => q
    q.limit = () => q
    q.maybeSingle = () => {
      op.terminal = 'maybeSingle'
      return Promise.resolve(settle())
    }
    q.single = () => {
      op.terminal = 'single'
      return Promise.resolve(settle())
    }
    q.then = (resolve: any, reject: any) =>
      Promise.resolve()
        .then(() => {
          op.terminal = 'then'
          return settle()
        })
        .then(resolve, reject)
    return q
  }

  const client = { from: (t: string) => builder(t) }
  return { client: client as unknown as Db, calls }
}

/** Filter recorded ops by table + kind. */
export function opsFor(calls: RecordedOp[], table: string, kind?: RecordedOp['kind']): RecordedOp[] {
  return calls.filter((o) => o.table === table && (kind ? o.kind === kind : true))
}

/** A silent logger so test output stays clean. */
export const quietLogger = { log() {}, warn() {}, error() {} }
