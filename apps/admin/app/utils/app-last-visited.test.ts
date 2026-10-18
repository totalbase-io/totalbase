import { describe, expect, it } from 'vitest'
import { appLocationFromPath, appOpeningLocation } from './app-last-visited'
import type { MenuNode } from '~/types/app-menu'

const object = (kind: 'DATAVIEW' | 'DASHBOARD', slug: string): MenuNode => ({ kind, id: slug, name: slug, slug, menuLabel: null, description: null, icon: null, color: null, viewType: null })
const menu: MenuNode[] = [
  { kind: 'GROUP', id: 'g', name: 'Sales', icon: null, iconOpen: null, openState: 'DEFAULT', children: [object('DASHBOARD', 'sales'), object('DATAVIEW', 'orders')] },
  object('DATAVIEW', 'customers')
]

describe('appLocationFromPath', () => {
  it('reads the object of a path under the App, a record page included', () => {
    expect(appLocationFromPath('/app/dataviews/orders')).toEqual({ kind: 'DATAVIEW', slug: 'orders' })
    expect(appLocationFromPath('/app/dataviews/orders/42/edit')).toEqual({ kind: 'DATAVIEW', slug: 'orders' })
    expect(appLocationFromPath('/app/dashboards/sales')).toEqual({ kind: 'DASHBOARD', slug: 'sales' })
  })
  it('ignores the App page and anything outside it', () => {
    expect(appLocationFromPath('/app')).toBeUndefined()
    expect(appLocationFromPath('/app/dataviews/')).toBeUndefined()
    expect(appLocationFromPath('/dashboards/sales')).toBeUndefined()
  })
})

describe('appOpeningLocation', () => {
  it('opens on the last visited object while the menu still shows it', () => {
    expect(appOpeningLocation(menu, { kind: 'DASHBOARD', slug: 'sales' }, { kind: 'DATAVIEW', slug: 'customers' })).toEqual({ kind: 'DATAVIEW', slug: 'customers' })
  })
  it('falls back to the home, then to the first object in reading order', () => {
    expect(appOpeningLocation(menu, { kind: 'DATAVIEW', slug: 'customers' }, { kind: 'DATAVIEW', slug: 'gone' })).toEqual({ kind: 'DATAVIEW', slug: 'customers' })
    expect(appOpeningLocation(menu, null, undefined)?.slug).toBe('sales')
    expect(appOpeningLocation(menu, { kind: 'DASHBOARD', slug: 'hidden' }, undefined)?.slug).toBe('sales')
  })
  it('has nowhere to go with an empty menu', () => {
    expect(appOpeningLocation([], null, { kind: 'DATAVIEW', slug: 'orders' })).toBeUndefined()
  })
})
