<script setup lang="ts">
// MAP layout of a DataView grid: one pin per row with a real lat/lng
// (`map_layout`, types/dataview.ts). Latitude/Longitude are plain columns;
// name/description/icon/color are formulas. No pager and no selection - a
// pin's popup opens the record.
import { DEFAULT_MAP_PIN_COLOR, DEFAULT_MAP_PIN_ICON, itemColor, DEFAULT_MAP_VIEW, type DataViewField, type MapLayoutConfig, type MapViewConfig } from '~/types/dataview'
import type { MapPin } from './DataViewMap.vue'
import { cappedNotice, columnField } from '~/utils/dataview-columns'

const props = defineProps<{
  rows: Record<string, unknown>[]
  fields: DataViewField[]
  layout?: MapLayoutConfig
  mapView?: MapViewConfig
  primaryKey?: string
  total: number
  limit: number
}>()
const emit = defineEmits<{
  edit: [row: Record<string, unknown>]
}>()

const { t } = useI18n()
const formula = useLayoutFormula(() => props.fields, () => [props.layout?.nameFormula, props.layout?.descriptionFormula, props.layout?.iconFormula, props.layout?.colorFormula])

/**
 * A row's location: its `point` column (`{ lng, lat }`, as the Data API
 * reads a point) or its latitude and longitude columns. One that isn't a
 * real number is left off the map (not plotted at 0,0) and counted.
 */
const resolved = computed<{ pins: MapPin[], skipped: number }>(() => {
  const pointColumn = columnField(props.fields, props.layout?.pointColumn)?.columnName
  const latColumn = columnField(props.fields, props.layout?.latitudeColumn)?.columnName
  const lngColumn = columnField(props.fields, props.layout?.longitudeColumn)?.columnName
  if (!pointColumn && (!latColumn || !lngColumn)) return { pins: [], skipped: 0 }
  const locate = (row: Record<string, unknown>): { lat: number, lng: number } => {
    if (pointColumn) {
      const point = formula.cellValue.value(row, pointColumn) as { lat?: unknown, lng?: unknown } | null | undefined
      return { lat: Number(point?.lat ?? Number.NaN), lng: Number(point?.lng ?? Number.NaN) }
    }
    return { lat: Number(formula.cellValue.value(row, latColumn!)), lng: Number(formula.cellValue.value(row, lngColumn!)) }
  }
  let skipped = 0
  const pins: MapPin[] = []
  props.rows.forEach((row, index) => {
    const { lat, lng } = locate(row)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped += 1
      return
    }
    const name = formula.evaluateRich(props.layout?.nameFormula, row)
    const description = props.layout?.descriptionFormula ? formula.evaluateRich(props.layout.descriptionFormula, row) : null
    pins.push({
      key: props.primaryKey ? String(row[props.primaryKey]) : String(index),
      lat,
      lng,
      name: name.text,
      nameRich: name.rich,
      description: description?.text || null,
      descriptionRich: description?.rich,
      icon: formula.evaluate(props.layout?.iconFormula, row) || props.layout?.defaultIcon || DEFAULT_MAP_PIN_ICON,
      // Not cast to RoleColor: a formula result that isn't a palette name
      // flows through, so the pin can flag it visibly.
      color: itemColor(formula.evaluate(props.layout?.colorFormula, row), props.layout?.defaultColor, DEFAULT_MAP_PIN_COLOR),
      row
    })
  })
  return { pins, skipped }
})
const capped = computed(() => cappedNotice(props.total, props.limit, t('dataviews.layouts.capWhere.map')))
</script>

<template>
  <UAlert
    v-if="capped"
    color="warning"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    :title="capped"
  />
  <UAlert
    v-if="resolved.skipped > 0"
    color="neutral"
    variant="subtle"
    icon="i-lucide-map-pin-off"
    :title="t('dataviews.layouts.skipped.map', { count: resolved.skipped })"
  />
  <DataViewMap
    class="min-h-96 flex-1"
    :pins="resolved.pins"
    :map-view="mapView ?? DEFAULT_MAP_VIEW"
    @edit="emit('edit', $event)"
  />
</template>
