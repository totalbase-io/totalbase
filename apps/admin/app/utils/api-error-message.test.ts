import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { AdminApiError } from '~/utils/admin-api-error'
import { apiErrorMessage, apiErrorText } from '~/utils/api-error-message'
import { createRecord, type RecordTransport } from '~/utils/record-engine'

const i18n = { t: (key: string) => key, te: () => true, locale: ref('es') }
const pg = (code: string, message: string) => new AdminApiError(409, [{ code, message, source: 'POSTGRESQL' }])

// A UNIQUE or FOREIGN KEY violation without a message of its own reads plainly, in the UI's language (T65).
describe('apiErrorMessage() - constraint defaults', () => {
  it('reads PostgreSQL\'s raw UNIQUE and FOREIGN KEY texts as plain messages', () => {
    expect(apiErrorMessage(i18n as never, pg('UNIQUE_VIOLATION', 'duplicate key value violates unique constraint "clientes_cuit_key"'))).toBe('errors.constraint.duplicate')
    expect(apiErrorMessage(i18n as never, pg('FOREIGN_KEY_VIOLATION', 'update or delete on table "sucursales" violates RESTRICT setting of foreign key constraint "x" on table "y"'))).toBe('errors.constraint.inUse')
    expect(apiErrorMessage(i18n as never, pg('FOREIGN_KEY_VIOLATION', 'insert or update on table "ventas" violates foreign key constraint "ventas_cliente_fkey"'))).toBe('errors.constraint.missing')
  })

  it('keeps a constraint\'s own message (its COMMENT) as written', () => {
    expect(apiErrorMessage(i18n as never, pg('UNIQUE_VIOLATION', 'Ese CUIT ya está cargado.'))).toBe('Ese CUIT ya está cargado.')
  })

  it('reads a record\'s errors the same way - a save or a delete in the App, not only a toast of the admin', async () => {
    expect(apiErrorText(i18n as never, { code: 'UNIQUE_VIOLATION', source: 'POSTGRESQL', message: 'duplicate key value violates unique constraint "categorias_nombre_key"' })).toBe('errors.constraint.duplicate')
    const notices: string[] = []
    const transport = {
      catalog: async () => ({ catalog: { columns: [{ name: 'id', dataType: 'integer', nullable: false, isIdentity: true, isGenerated: false, defaultExpression: null }, { name: 'nombre', dataType: 'text', nullable: false, isIdentity: false, isGenerated: false, defaultExpression: null }], primaryKey: ['id'], relations: [] }, writable: { create: ['nombre'], update: ['nombre'] } }),
      read: async () => null,
      create: async () => { throw pg('UNIQUE_VIOLATION', 'duplicate key value violates unique constraint "categorias_nombre_key"') },
      update: async () => ({}),
      remove: async () => {}
    } as RecordTransport
    const { handle, start } = createRecord({ transport, notify: message => notices.push(message), describe: e => apiErrorText(i18n as never, e) })
    await start()
    handle.set('nombre', 'Repetida')
    expect(await handle.save()).toBe(false)
    expect(notices).toEqual(['errors.constraint.duplicate'])
  })
})

describe('apiErrorText() - a refusal keeps its details', () => {
  const t = (key: string, params?: Record<string, string>) => params ? `${key}(${Object.values(params).join('|')})` : key
  const es = { t, te: () => true, locale: ref('es') }
  it('names the action, the table and whose roles, in the UI\'s language', () => {
    expect(apiErrorText(es as never, { code: 'ACTION_DENIED', source: 'TOTALBASE', message: 'No READ grant on public.customers for your roles.' }))
      .toBe('errors.actionDeniedOn(errors.actions.READ|public.customers|errors.deniedYourRoles)')
    expect(apiErrorText(es as never, { code: 'ACTION_DENIED', source: 'TOTALBASE', message: 'No UPDATE grant on public.orders for Technician.' }))
      .toBe('errors.actionDeniedOn(errors.actions.UPDATE|public.orders|Technician)')
  })
  it('any other refusal reads as before', () => {
    expect(apiErrorText(es as never, { code: 'ACTION_DENIED', source: 'TOTALBASE', message: 'This DataView doesn\'t let its viewers edit.' })).toBe('errors.ACTION_DENIED')
  })
})
