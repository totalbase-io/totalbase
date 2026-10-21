// Generated images (DATASET.md §10): equipment and vehicle photos, technician portraits,
// customer signatures and work order photos - drawn as SVG, rendered to PNG by rsvg-convert, uploaded
// through the MCP server and set on their rows. No real people or brands.
//   TOTALBASE_TOKEN=... node 10-images.mjs
import { execFileSync } from 'node:child_process'
import { call } from './mcp.mjs'

const json = async (tool, args) => JSON.parse(await call(tool, args))
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const png = (svg, width) => execFileSync('rsvg-convert', ['-w', String(width), '-f', 'png'], { input: svg }).toString('base64')
const upload = async (name, svg, width) => (await json('upload_file', { name, mime_type: 'image/png', content_base64: png(svg, width) })).id
const sql = async statement => call('execute_sql', { sql: statement })

const PALETTE = ['#0e7490', '#4f46e5', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#65a30d']

// Equipment: one photo per model - a unit on a wall, its brand and model.
const unit = (brand, model, category, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f5f9"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs>
  <rect width="400" height="300" fill="url(#g)"/>
  ${category === 'SOLAR'
    ? `<g transform="translate(70 70) skewX(-12)">${[0, 1, 2].map(r => [0, 1, 2, 3].map(c => `<rect x="${c * 62}" y="${r * 42}" width="58" height="38" fill="#1e3a8a" stroke="#93c5fd" stroke-width="2"/>`).join('')).join('')}</g>`
    : category === 'GENERATOR'
      ? `<rect x="90" y="90" width="220" height="130" rx="10" fill="${color}"/><rect x="110" y="110" width="80" height="50" rx="4" fill="#0f172a" opacity=".7"/><circle cx="260" cy="140" r="22" fill="#e2e8f0"/>`
      : `<rect x="70" y="95" width="260" height="90" rx="14" fill="#f8fafc" stroke="#94a3b8" stroke-width="3"/><rect x="90" y="160" width="220" height="10" rx="5" fill="#cbd5e1"/><circle cx="300" cy="118" r="5" fill="${color}"/>`}
  <text x="200" y="262" font-family="Arial" font-size="20" font-weight="bold" fill="#0f172a" text-anchor="middle">${brand} ${model}</text></svg>`
const models = rows(await json('query_records', { name: 'equipment_models', fields: 'id,brand,model,category' }))
for (const [i, m] of models.entries()) {
  const file = await upload(`${m.brand} ${m.model}.png`, unit(m.brand, m.model, m.category, PALETTE[i % 8]), 800)
  await sql(`UPDATE public.equipment SET photo = '${file}' WHERE model = '${m.id}'`)
}

// Vehicles: a van's side, colored by branch, its plate.
const van = (plate, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#e2e8f0"/><rect y="230" width="400" height="70" fill="#94a3b8"/>
  <path d="M40 220 V120 Q40 100 60 100 H250 L320 150 H350 Q365 150 365 170 V220 Z" fill="#f8fafc" stroke="#475569" stroke-width="3"/>
  <path d="M255 110 L305 150 H255 Z" fill="#bae6fd" stroke="#475569" stroke-width="2"/><rect x="40" y="170" width="325" height="14" fill="${color}"/>
  <circle cx="110" cy="225" r="26" fill="#1e293b"/><circle cx="110" cy="225" r="10" fill="#94a3b8"/><circle cx="300" cy="225" r="26" fill="#1e293b"/><circle cx="300" cy="225" r="10" fill="#94a3b8"/>
  <text x="140" y="150" font-family="Arial" font-size="18" font-weight="bold" fill="${color}">ACME FIELD</text>
  <rect x="150" y="262" width="100" height="26" rx="3" fill="#fff" stroke="#0f172a"/><text x="200" y="281" font-family="monospace" font-size="16" font-weight="bold" text-anchor="middle">${plate}</text></svg>`
const BRANCH_COLOR = { SAL: '#0e7490', JUJ: '#059669', TUC: '#d97706' }
const branchCode = Object.fromEntries(rows(await json('query_records', { name: 'branches', fields: 'id,code' })).map(b => [b.id, b.code]))
for (const v of rows(await json('query_records', { name: 'vehicles', fields: 'id,plate,branch' }))) {
  const file = await upload(`Van ${v.plate}.png`, van(v.plate, BRANCH_COLOR[branchCode[v.branch]]), 800)
  await sql(`UPDATE public.vehicles SET photo = '${file}' WHERE id = '${v.id}'`)
}

// Technicians: an illustrated portrait - a person in the company's shirt, their skin, hair and background varied by
// their place in the list, so an org chart reads as people, not initials.
const SKINS = ['#f1c7a5', '#e0a77f', '#c68863', '#8d5a3b', '#f5d6bc', '#a86f4c']
const HAIRS = ['#2b1d16', '#5a3825', '#a0693a', '#1c1c1c', '#d9b26f', '#7a4b2a']
const portrait = (name, color, i) => {
  const skin = SKINS[i % SKINS.length]
  const hair = HAIRS[(i * 5) % HAIRS.length]
  // Short, side-parted, long or tied back - by turns.
  const style = i % 4
  const back = style === 2 ? `<path d="M88 150 Q80 260 110 300 L190 300 Q220 260 212 150 Z" fill="${hair}"/>` : style === 3 ? `<circle cx="150" cy="78" r="26" fill="${hair}"/>` : ''
  const top = style === 1
    ? `<path d="M92 150 Q90 86 150 82 Q214 84 210 150 Q196 112 132 108 Q104 118 92 150 Z" fill="${hair}"/>`
    : `<path d="M90 150 Q88 84 150 82 Q212 84 210 150 Q200 116 150 112 Q100 116 90 150 Z" fill="${hair}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity=".12"/></linearGradient></defs>
  <rect width="300" height="400" fill="url(#bg)"/>${back}
  <path d="M30 400 Q34 300 150 292 Q266 300 270 400 Z" fill="#0e7490"/>
  <path d="M122 292 L150 330 L178 292 Z" fill="#e2e8f0"/>
  <rect x="128" y="236" width="44" height="62" rx="18" fill="${skin}"/>
  <ellipse cx="150" cy="166" rx="60" ry="74" fill="${skin}"/>
  <ellipse cx="90" cy="170" rx="9" ry="15" fill="${skin}"/><ellipse cx="210" cy="170" rx="9" ry="15" fill="${skin}"/>
  ${top}
  <path d="M118 152 Q128 146 138 152" stroke="${hair}" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M162 152 Q172 146 182 152" stroke="${hair}" stroke-width="4" fill="none" stroke-linecap="round"/>
  <circle cx="128" cy="168" r="5.5" fill="#1f2937"/><circle cx="172" cy="168" r="5.5" fill="#1f2937"/>
  <path d="M148 176 Q144 192 152 194" stroke="#00000033" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M130 208 Q150 224 170 208" stroke="#9f1239" stroke-width="5" fill="none" stroke-linecap="round"/>
  <title>${name}</title></svg>`
}
for (const [i, t] of rows(await json('query_records', { name: 'technicians', fields: 'id,name' })).entries()) {
  const file = await upload(`${t.name}.png`, portrait(t.name, PALETTE[i % 8], i), 600)
  await sql(`UPDATE public.technicians SET photo = '${file}' WHERE id = '${t.id}'`)
}

// Signatures: five handwritten-looking strokes, on the completed orders.
const signature = seed => {
  let d = 'M20 70'
  for (let x = 40; x <= 360; x += 20) d += ` Q${x - 10} ${30 + ((seed * x) % 50)} ${x} ${55 + ((seed * 7 + x) % 30)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120" viewBox="0 0 400 120"><rect width="400" height="120" fill="#fff"/>
  <path d="${d}" fill="none" stroke="#1e3a8a" stroke-width="3" stroke-linecap="round"/><line x1="20" y1="100" x2="380" y2="100" stroke="#cbd5e1"/></svg>`
}
const signatures = []
for (const s of [3, 7, 11, 13, 17]) signatures.push(await upload(`Signature ${s}.png`, signature(s), 400))
await sql(`UPDATE public.work_orders SET customer_signature = (ARRAY['${signatures.join("','")}']::uuid[])[1 + abs(hashtext(number)) % 5] WHERE status = 'COMPLETED'`)

// Work order photos: a few close-ups on the latest completed and in-progress orders.
const closeup = (label, color) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#334155"/><circle cx="200" cy="140" r="90" fill="${color}" opacity=".85"/><circle cx="200" cy="140" r="40" fill="#e2e8f0"/>
  <rect x="0" y="250" width="400" height="50" fill="#0f172a" opacity=".7"/><text x="16" y="282" font-family="Arial" font-size="18" fill="#fff">${label}</text></svg>`
const photos = []
for (const [label, color] of [['Before - condenser coil', '#94a3b8'], ['After - coil cleaned', '#0e7490'], ['Replaced capacitor', '#d97706'], ['Inverter display', '#059669']]) {
  photos.push(await upload(`${label}.png`, closeup(label, color), 800))
}
await sql(`INSERT INTO public.work_order_photos (work_order, file, caption, taken_at)
  SELECT o.id, (ARRAY['${photos.join("','")}']::uuid[])[1 + k], (ARRAY['Before - condenser coil', 'After - coil cleaned', 'Replaced capacitor', 'Inverter display'])[1 + k], coalesce(o.completed_at, now()) - interval '30 minutes'
  FROM (SELECT id, completed_at FROM public.work_orders WHERE status IN ('COMPLETED', 'IN_PROGRESS') ORDER BY reported_at DESC LIMIT 12) o, generate_series(0, 1) k`)
console.log('images done')
