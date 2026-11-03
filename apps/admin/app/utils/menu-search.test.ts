import { describe, expect, it } from 'vitest'
import type { MenuNode } from '~/types/app-menu'
import { countEntries, filterMenu, foldText, highlightParts } from '~/utils/menu-search'

const item = (name: string, menuLabel: string | null = null, description: string | null = null): MenuNode =>
  ({ kind: 'DATAVIEW', id: name, name, slug: name, menuLabel, description, icon: null, color: null, viewType: 'TABLE' })
const group = (name: string, children: MenuNode[]): MenuNode => ({ kind: 'GROUP', id: name, name, icon: null, iconOpen: null, openState: 'DEFAULT', children })

// The App menu's search box (Security.md §8.2).
describe('menu search', () => {
  const menu = [
    group('Sucursales', [item('Sucursales'), item('Mapa de sucursales', 'Mapa'), item('Sucursales habilitadas')]),
    group('Equipos', [item('Dispositivos', null, 'Celulares lectores de cada sucursal'), item('Impresoras')]),
    item('Clientes'),
    group('Ventas', [group('Facturación', [item('Facturas'), item('Notas de crédito')])]),
    group('Equipo', [{ kind: 'MODULE', id: 'm-users', module: 'users', name: null, icon: null }, { kind: 'MODULE', id: 'm-logs', module: 'logs', name: 'Actividad', icon: null }])
  ]
  const moduleLabel = (module: { module: string }) => ({ users: 'Usuarios', logs: 'Registros' })[module.module] ?? module.module

  it('finds a module by its own label or its rail name in the UI language', () => {
    expect(filterMenu(menu, 'usuar', moduleLabel).map(n => n.name)).toEqual(['Equipo'])
    expect((filterMenu(menu, 'activid', moduleLabel)[0] as { children: MenuNode[] }).children.map(n => n.id)).toEqual(['m-logs'])
    // Without labels only a module's own label matches.
    expect(filterMenu(menu, 'usuar')).toEqual([])
  })

  it('finds an entry by its label, full name or description, and a group whole - case and accents aside', () => {
    const found = filterMenu(menu, 'SUCURSAL')
    expect(found.map(n => n.name)).toEqual(['Sucursales', 'Equipos'])
    expect((found[0] as { children: MenuNode[] }).children).toHaveLength(3)
    expect((found[1] as { children: MenuNode[] }).children.map(n => n.name)).toEqual(['Dispositivos'])
    // Accents ignored, inside a subgroup.
    const credit = filterMenu(menu, 'credito')
    expect(credit.map(n => n.name)).toEqual(['Ventas'])
    expect(filterMenu(menu, 'zzz')).toEqual([])
    expect(countEntries(menu)).toBe(10)
  })

  it('marks what matched, accents and case as written', () => {
    expect(foldText('Facturación')).toBe('facturacion')
    expect(highlightParts('Notas de Crédito', 'credito')).toEqual([{ text: 'Notas de ', match: false }, { text: 'Crédito', match: true }])
    expect(highlightParts('Mapa', 'x')).toEqual([{ text: 'Mapa', match: false }])
  })
})
