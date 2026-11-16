// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './copy-text'

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('copies through the clipboard API when the page has one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('copies the older way on a page without it (plain HTTP)', async () => {
    vi.stubGlobal('navigator', {})
    const exec = vi.fn().mockReturnValue(true)
    document.execCommand = exec
    await copyText('hello')
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('rejects when nothing copies, so the caller can say so', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    document.execCommand = vi.fn().mockReturnValue(false)
    await expect(copyText('hello')).rejects.toThrow()
  })
})
