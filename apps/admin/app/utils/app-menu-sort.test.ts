import { describe, expect, it } from 'vitest'
import type { MenuGroup, MenuNode, MenuObject } from '~/types/app-menu'
import { sortMenu } from './app-menu-sort'

const entry = (name: string, kind: MenuObject['kind'] = 'DATAVIEW', viewType: string | null = 'TABLE'): MenuObject =>
  ({ kind, id: name, name, slug: name, menuLabel: null, description: null, icon: null, color: null, viewType })
const group = (name: string, children: MenuNode[]): MenuGroup => ({ kind: 'GROUP', id: name, name, icon: null, iconOpen: null, openState: 'DEFAULT', children })
const typeOf = (object: MenuObject) => (object.kind === 'DASHBOARD' ? 'Dashboard' : `DataView · ${object.viewType}`)
const names = (nodes: MenuNode[]) => nodes.map(n => n.name)

describe('sortMenu', () => {
  it('sorts by name with groups first, ignoring case and accents, numbers naturally', () => {
    const sorted = sortMenu([entry('test 10'), entry('Ábaco'), group('Zeta', []), entry('Test 2'), group('alfa', []), entry('banco')], 'NAME', 'ASC', typeOf, 'es')
    expect(names(sorted)).toEqual(['alfa', 'Zeta', 'Ábaco', 'banco', 'Test 2', 'test 10'])
  })

  it('DESC reverses the order but keeps groups first', () => {
    const sorted = sortMenu([entry('A'), group('G1', []), entry('C'), group('G2', []), entry('B')], 'NAME', 'DESC', typeOf, 'en')
    expect(names(sorted)).toEqual(['G2', 'G1', 'C', 'B', 'A'])
  })

  it('sorts inside every group and subgroup too', () => {
    const tree = [group('Sales', [entry('Orders'), group('Reports', [entry('Monthly'), entry('Annual')]), entry('Invoices')])]
    const sorted = sortMenu(tree, 'NAME', 'ASC', typeOf, 'en')
    const sales = sorted[0] as MenuGroup
    expect(names(sales.children)).toEqual(['Reports', 'Invoices', 'Orders'])
    expect(names((sales.children[0] as MenuGroup).children)).toEqual(['Annual', 'Monthly'])
    // A new tree: the input is untouched.
    expect(names((tree[0] as MenuGroup).children)).toEqual(['Orders', 'Reports', 'Invoices'])
  })

  it('sorts by type, then by name for the same type, and reverses both in DESC', () => {
    const list = [entry('Zoo', 'DATAVIEW', 'TABLE'), entry('Board', 'DATAVIEW', 'KANBAN'), entry('Sales', 'DASHBOARD', null), entry('Apps', 'DATAVIEW', 'TABLE'), group('G', [])]
    expect(names(sortMenu(list, 'TYPE', 'ASC', typeOf, 'en'))).toEqual(['G', 'Sales', 'Board', 'Apps', 'Zoo'])
    expect(names(sortMenu(list, 'TYPE', 'DESC', typeOf, 'en'))).toEqual(['G', 'Zoo', 'Apps', 'Board', 'Sales'])
  })
})
