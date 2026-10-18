import { mapLocationReady } from '~/types/dataview'
import { describe, expect, it } from 'vitest'
import {
  columnFormula,
  emptyCalendarLayout,
  emptyCardLayout,
  emptyGanttLayout,
  emptyKanbanLayout,
  emptyMapLayout,
  emptyTreeLayout,
  formulaColumn,
  pickCalendarLayout,
  pickCardLayout,
  pickGanttLayout,
  pickKanbanLayout,
  pickMapLayout,
  pickTreeLayout,
  type WizardColumn
} from './dataview-wizard-layouts'

const col = (name: string, dataType = 'text', isForeignKey = false): WizardColumn => ({ name, label: name, dataType, isForeignKey })
const TEXT = col('title')
const NOTES = col('notes')
const LAT = col('lat', 'numeric')
const LNG = col('lng', 'double precision')
const STARTS = col('starts_at', 'timestamp with time zone')
const ENDS = col('ends_at', 'date')
const STATUS = col('status', 'uuid', true)

describe('formulaColumn / columnFormula', () => {
  it('round-trips a column through the bare formula', () => {
    expect(columnFormula('title')).toBe('{{title}}')
    expect(formulaColumn('{{ title }}')).toBe('title')
    expect(columnFormula(null)).toBeNull()
  })

  it('reads no column out of a real formula', () => {
    expect(formulaColumn('CONCATENATE({{a}}, {{b}})')).toBeNull()
    expect(formulaColumn(null)).toBeNull()
  })
})

describe('pickCardLayout', () => {
  it('defaults the title to the first column and keeps optional slots empty', () => {
    expect(pickCardLayout(emptyCardLayout(), [TEXT, NOTES])).toEqual({ imageFormula: null, titleFormula: '{{title}}', descriptionFormula: null, imageAspect: null, imageFit: null, imagePosition: null })
  })

  it('drops a mapping whose column the Columns step excluded', () => {
    const layout = { imageFormula: '{{photo}}', titleFormula: '{{notes}}', descriptionFormula: '{{notes}}', imageAspect: '3:4' as const }
    expect(pickCardLayout(layout, [TEXT])).toEqual({ imageFormula: null, titleFormula: '{{title}}', descriptionFormula: null, imageAspect: null, imageFit: null, imagePosition: null })
  })
  it('keeps how the image shows while its image stays', () => {
    const layout = { imageFormula: '{{photo}}', titleFormula: null, descriptionFormula: null, imageAspect: '3:4' as const, imageFit: 'cover' as const, imagePosition: 'top' as const }
    expect(pickCardLayout(layout, [col('photo')])).toMatchObject({ imageAspect: '3:4', imageFit: 'cover', imagePosition: 'top' })
  })
})

describe('pickMapLayout', () => {
  it('auto-picks two distinct numeric columns for latitude/longitude', () => {
    const layout = pickMapLayout(emptyMapLayout(), [TEXT, LAT, LNG])
    expect([layout.latitudeColumn, layout.longitudeColumn]).toEqual(['lat', 'lng'])
    expect(layout.nameFormula).toBe('{{title}}')
  })

  it('uses a point column when there is no numeric pair, and keeps one chosen - never both modes', () => {
    const PLACE = col('place', 'point')
    expect(pickMapLayout(emptyMapLayout(), [TEXT, PLACE])).toMatchObject({ pointColumn: 'place', latitudeColumn: null, longitudeColumn: null })
    expect(pickMapLayout({ ...emptyMapLayout(), pointColumn: 'place' }, [TEXT, LAT, LNG, PLACE])).toMatchObject({ pointColumn: 'place', latitudeColumn: null, longitudeColumn: null })
    expect(pickMapLayout(emptyMapLayout(), [TEXT, LAT, LNG, PLACE])).toMatchObject({ pointColumn: null, latitudeColumn: 'lat', longitudeColumn: 'lng' })
  })

  it('mapLocationReady: a point column, or both latitude and longitude', () => {
    expect(mapLocationReady({ pointColumn: 'place', latitudeColumn: null, longitudeColumn: null })).toBe(true)
    expect(mapLocationReady({ pointColumn: null, latitudeColumn: 'lat', longitudeColumn: 'lng' })).toBe(true)
    expect(mapLocationReady({ pointColumn: null, latitudeColumn: 'lat', longitudeColumn: null })).toBe(false)
  })

  it('never keeps a non-numeric latitude, and never reuses it for longitude', () => {
    const layout = pickMapLayout({ ...emptyMapLayout(), latitudeColumn: 'title' }, [TEXT, LAT])
    expect(layout.latitudeColumn).toBe('lat')
    expect(layout.longitudeColumn).toBeNull()
  })
})

describe('pickKanbanLayout', () => {
  it('groups by a foreign key and titles by the first plain column', () => {
    const layout = pickKanbanLayout(emptyKanbanLayout(), [STATUS, TEXT])
    expect(layout.groupColumn).toBe('status')
    expect(layout.titleFormula).toBe('{{title}}')
    expect(layout.laneOrder).toEqual([])
  })

  it('has no group column without a foreign key', () => {
    expect(pickKanbanLayout(emptyKanbanLayout(), [TEXT]).groupColumn).toBeNull()
  })
})

describe('pickCalendarLayout', () => {
  it('places rows by the first date column and titles by another', () => {
    const layout = pickCalendarLayout(emptyCalendarLayout(), [STARTS, TEXT])
    expect(layout.dateColumn).toBe('starts_at')
    expect(layout.titleFormula).toBe('{{title}}')
  })
})

describe('pickGanttLayout', () => {
  it('picks distinct start/end dates, leaves Group by optional', () => {
    const layout = pickGanttLayout(emptyGanttLayout(), [STARTS, ENDS, STATUS, TEXT])
    expect([layout.startDateColumn, layout.endDateColumn]).toEqual(['starts_at', 'ends_at'])
    expect(layout.groupColumn).toBeNull()
    expect(layout.titleFormula).toBe('{{status}}')
  })

  it('keeps a mapped foreign key group column while it stays visible', () => {
    expect(pickGanttLayout({ ...emptyGanttLayout(), groupColumn: 'status' }, [STARTS, ENDS, STATUS]).groupColumn).toBe('status')
    expect(pickGanttLayout({ ...emptyGanttLayout(), groupColumn: 'status' }, [STARTS, ENDS]).groupColumn).toBeNull()
  })
})

describe('pickTreeLayout', () => {
  const PARENT: WizardColumn = { ...col('parent', 'uuid', true), isSelfReference: true }
  const POSITION = col('position', 'integer')
  it('takes the foreign key to its own table as the parent - hidden too - and titles by the first other column', () => {
    const layout = pickTreeLayout(emptyTreeLayout(), [STATUS, TEXT], [PARENT, STATUS, TEXT, POSITION])
    expect(layout.parentColumn).toBe('parent')
    expect(layout.titleFormula).toBe('{{title}}')
    // The order only when picked - never guessed from a name.
    expect(layout.orderColumn).toBeNull()
    expect(pickTreeLayout({ ...emptyTreeLayout(), orderColumn: 'position' }, [TEXT], [PARENT, TEXT, POSITION]).orderColumn).toBe('position')
  })

  it('has no parent when the table has no foreign key to itself', () => {
    expect(pickTreeLayout(emptyTreeLayout(), [STATUS, TEXT]).parentColumn).toBeNull()
  })
})
