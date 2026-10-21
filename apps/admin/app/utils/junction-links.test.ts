import { describe, expect, it, vi } from 'vitest'
import { createRecord, type RecordCatalog, type RecordTransport } from '~/utils/record-engine'
import { createJunctionLinks, type JunctionCatalog } from '~/utils/junction-links'

const JUNCTION: JunctionCatalog = {
  resourceId: 'j',
  schema: 'public',
  table: 'projects_techs',
  primaryKey: 'id',
  column: 'project',
  otherColumn: 'tech',
  target: { resourceId: 't', schema: 'public', table: 'techs', column: 'id' },
  actions: { read: true, create: true, delete: true }
}
const ROWS = [{ id: 'j1', other: 7 }, { id: 'j2', other: 8 }]

function links(junction: Partial<JunctionCatalog> = {}) {
  return createJunctionLinks({ junction: { ...JUNCTION, ...junction }, read: vi.fn(async () => ROWS), keyPrefix: 'techs' })
}

describe('createJunctionLinks', () => {
  it('reads the links, and writes only what changed: an insert per link added, a delete per link removed', async () => {
    const { handle, lines, load } = links()
    await load('p1')
    expect(handle.values).toEqual([7, 8])
    expect(lines.pending()).toBe(false)
    handle.set([8, 9])
    expect(lines.pending()).toBe(true)
    expect(lines.operations('p1')).toEqual([
      { key: 'techsRemove1', operation: 'delete', schema: 'public', table: 'projects_techs', id: 'j1' },
      { key: 'techsAdd1', operation: 'insert', schema: 'public', table: 'projects_techs', data: { project: 'p1', tech: 9 } }
    ])
    lines.discard()
    expect(handle.values).toEqual([7, 8])
    expect(lines.pending()).toBe(false)
  })

  it('links a new record by its key in the same save, and never picks a value twice', async () => {
    const { handle, lines, load } = links()
    await load(null)
    handle.set([7, 7])
    expect(lines.operations('$header.id')).toEqual([
      { key: 'techsAdd1', operation: 'insert', schema: 'public', table: 'projects_techs', data: { project: '$header.id', tech: 7 } }
    ])
  })

  it('never offers what the viewer may not do: no CREATE keeps out new links, no DELETE keeps the old ones', async () => {
    const noCreate = links({ actions: { read: true, create: false, delete: true } })
    await noCreate.load('p1')
    noCreate.handle.set([8, 9])
    expect(noCreate.handle.values).toEqual([8])
    const noDelete = links({ actions: { read: true, create: true, delete: false } })
    await noDelete.load('p1')
    noDelete.handle.set([9])
    expect(noDelete.handle.values).toEqual([9, 7, 8])
  })

  it('joins the record\'s save: a record whose only change is its links saves them together', async () => {
    const catalog: RecordCatalog = {
      catalog: { columns: [{ name: 'id', dataType: 'uuid', nullable: false, isIdentity: false, isGenerated: false, defaultExpression: 'gen_random_uuid()' }], primaryKey: ['id'], relations: [] },
      writable: { create: ['id'], update: ['id'] }
    }
    const saveTogether = vi.fn(async () => ({}))
    const transport: RecordTransport = {
      catalog: async () => catalog,
      read: async pk => ({ id: pk }),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      table: { schema: 'public', name: 'projects' },
      saveTogether
    }
    const { handle: record, start } = createRecord({ transport })
    await start('p1')
    const { handle, lines, load } = createJunctionLinks({ junction: JUNCTION, read: async () => ROWS, keyPrefix: 'techs', changed: () => record.linesChanged() })
    record.attach(lines)
    await load('p1')
    handle.set([7])
    expect(record.dirty).toBe(true)
    expect(await record.save()).toBe(true)
    expect(saveTogether).toHaveBeenCalledWith([{ key: 'techsRemove1', operation: 'delete', schema: 'public', table: 'projects_techs', id: 'j2' }])
  })
})
