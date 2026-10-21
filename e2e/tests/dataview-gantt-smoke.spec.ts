import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView } from './helpers.js'

/**
 * Smoke test for the new GANTT DataView layout - not a permanent fixture,
 * just verification that the timeline actually renders bars grouped into
 * swimlanes by a Foreign Key column, per view_config.gantt_layout.
 */
const NAME = 'Gantt Smoke Test'

test('a GANTT DataView renders bars grouped into swimlanes by project', async ({ page }) => {
  const token = await login(page)

  const existingDataviews = await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')
  for (const dv of existingDataviews.filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DELETE FROM totalbase.resources WHERE schema = 'public' AND name IN ('gantt_smoke_tasks', 'gantt_smoke_projects');
      DROP TABLE IF EXISTS public.gantt_smoke_tasks CASCADE;
      DROP TABLE IF EXISTS public.gantt_smoke_projects CASCADE;
      CREATE TABLE public.gantt_smoke_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL
      );
      CREATE TABLE public.gantt_smoke_tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES public.gantt_smoke_projects(id),
        title text NOT NULL,
        start_date date NOT NULL,
        end_date date NOT NULL
      );
      INSERT INTO public.gantt_smoke_projects (id, name) VALUES
        ('11111111-1111-1111-1111-111111111111', 'Launch'),
        ('22222222-2222-2222-2222-222222222222', 'Migration');
      INSERT INTO public.gantt_smoke_tasks (project_id, title, start_date, end_date) VALUES
        ('11111111-1111-1111-1111-111111111111', 'Design', CURRENT_DATE - 2, CURRENT_DATE + 3),
        ('11111111-1111-1111-1111-111111111111', 'Build', CURRENT_DATE + 4, CURRENT_DATE + 10),
        ('22222222-2222-2222-2222-222222222222', 'Data export', CURRENT_DATE - 5, CURRENT_DATE + 1);
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', '/api/totalbase/table/resources?fields=id,name,schema,status&where[type][_eq]=TABLE&limit=500'
  )
  const tasksResource = resources.find(r => r.schema === 'public' && r.name === 'gantt_smoke_tasks' && r.status === 'ACTIVE')
  const projectsResource = resources.find(r => r.schema === 'public' && r.name === 'gantt_smoke_projects' && r.status === 'ACTIVE')
  expect(tasksResource).toBeTruthy()
  expect(projectsResource).toBeTruthy()
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${tasksResource!.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${projectsResource!.id}`, { data: { exposedMethods: ['GET'] } })

  const dataview = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', {
    data: {
      name: NAME,
      description: 'Gantt e2e fixture',
      sourceResourceId: tasksResource!.id,
      viewType: 'GANTT',
      viewConfig: {
        gantt_layout: {
          startDateColumn: 'start_date',
          endDateColumn: 'end_date',
          groupColumn: 'project_id',
          titleFormula: '{{title}}',
          descriptionFormula: null,
          colorFormula: null,
          defaultColor: 'primary',
          laneOrder: [],
          defaultZoom: 'day'
        }
      }
    }
  })

  // project_id shows its project's `name` - the column a foreign key shows by default (DataViews.md §4.4).
  await publishDataView(page, token, dataview.id)
  await page.goto(`/admin/app/dataviews/${dataview.slug}`)
  await expect(page.getByText('Launch (2)')).toBeVisible()
  await expect(page.getByText('Migration (1)')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Design' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Build' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Data export' })).toBeVisible()

  // Zoom switcher actually re-renders at a different scale (Month has
  // fewer, wider header cells than Day) - a crude but real check that
  // DataViewGantt.vue's own `zoom` model isn't inert.
  await page.getByRole('button', { name: 'Month', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Design' })).toBeVisible()

  await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dataview.id}`)
})
