import { describe, expect, it } from 'vitest'
import { imageSource } from './image-source'

// Security regression (DataViews.md §9.10): any `src` starting with "/" was fetched with the viewer's token - a
// record's value of `/admin/api/...` read an Admin API route as the viewer, `//host/x` another host.
describe('imageSource', () => {
  it('reads only a file with the viewer token, shows only https URLs as they are', () => {
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    expect(imageSource(id)).toEqual({ file: id })
    expect(imageSource(`/api/totalbase/table/files/${id}`)).toEqual({ file: id })
    expect(imageSource('https://cdn.example.com/a.png')).toEqual({ url: 'https://cdn.example.com/a.png' })
    for (const src of ['/admin/api/users', '//evil.example/x.png', `/api/totalbase/table/files/${id}/../../users`, 'javascript:alert(1)', 'http://plain.example/a.png', '', null]) {
      expect(imageSource(src), String(src)).toBeNull()
    }
  })
})
