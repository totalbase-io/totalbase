import { describe, expect, it } from 'vitest'
import { isPortalPathAllowed, portalHomeFor } from './role-access'

describe('portalHomeFor', () => {
  it('sends an administrator to Status and everyone else to the App', () => {
    expect(portalHomeFor('ADMIN')).toBe('/status')
    expect(portalHomeFor('APP')).toBe('/app')
    expect(portalHomeFor(undefined)).toBe('/app')
  })
})

describe('isPortalPathAllowed', () => {
  it('confines an APP user to the app', () => {
    expect(isPortalPathAllowed('/app', 'APP')).toBe(true)
    expect(isPortalPathAllowed('/app/orders', 'APP')).toBe(true)
    expect(isPortalPathAllowed('/', 'APP')).toBe(false)
    expect(isPortalPathAllowed('/status', 'APP')).toBe(false)
    expect(isPortalPathAllowed('/database/resources', 'APP')).toBe(false)
    expect(isPortalPathAllowed('/applications', 'APP')).toBe(false)
  })

  it('lets an APP user reach their own account, and nothing that merely starts like it', () => {
    expect(isPortalPathAllowed('/account', 'APP')).toBe(true)
    expect(isPortalPathAllowed('/account?tab=sessions', 'APP')).toBe(true)
    expect(isPortalPathAllowed('/accounts', 'APP')).toBe(false)
    expect(isPortalPathAllowed('/account/other', 'APP')).toBe(false)
  })

  it('lets an ADMIN user reach both the admin and the app', () => {
    expect(isPortalPathAllowed('/database/resources', 'ADMIN')).toBe(true)
    expect(isPortalPathAllowed('/app', 'ADMIN')).toBe(true)
  })
})

describe('isPortalPathAllowed - delegated modules', () => {
  it('opens a delegated module for an APP user who holds it, and only that one', () => {
    expect(isPortalPathAllowed('/users', 'APP', ['users'])).toBe(true)
    expect(isPortalPathAllowed('/users/abc', 'APP', ['users'])).toBe(true)
    expect(isPortalPathAllowed('/roles', 'APP', ['users'])).toBe(false)
    expect(isPortalPathAllowed('/users', 'APP')).toBe(false)
  })

  it('never opens a module\'s administrator-only pages', () => {
    expect(isPortalPathAllowed('/users/insights/sign-ins', 'APP', ['users'])).toBe(false)
    expect(isPortalPathAllowed('/templates/system/password_reset', 'APP', ['templates'])).toBe(false)
    expect(isPortalPathAllowed('/templates/abc', 'APP', ['templates'])).toBe(true)
    expect(isPortalPathAllowed('/tokens', 'APP', ['users'])).toBe(false)
  })
})
