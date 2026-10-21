// @ts-check
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // The UI is translated (Admin_UI.md §14): a text a template
  // shows - its content or a label/title/description/aria-label/text/
  // placeholder attribute - comes from the locale files, never written in
  // place. What reads the same in every language (symbols, product and
  // technical names) is allowed.
  {
    files: ['app/**/*.vue'],
    plugins: { '@intlify/vue-i18n': vueI18n },
    rules: {
      '@intlify/vue-i18n/no-raw-text': ['error', {
        attributes: { '/.+/': ['label', 'title', 'description', 'aria-label', 'text', 'placeholder'] },
        ignorePattern: '^[\\s\\d\\p{P}\\p{S}×·…–—→←↑↓•]*$',
        ignoreText: [
          'TotalBase', 'PostgreSQL', 'SQL', 'JSON', 'API', 'URL', 'ID', 'IP', 'CSV', 'PDF', 'HTML', 'HTTP', 'OpenAPI', 'Data API', 'Admin API',
          'DataView', 'DataViews', 'Dashboard', 'Dashboards', 'Workflow', 'Workflows', 'Mapbox', 'OpenStreetMap', 'Cc', 'Bcc', 'SMTP', 'OIDC',
          'UUID', 'NULL', 'PK', 'FK', 'SQLSTATE', 'ALLOW', 'DENY', 'CREATE', 'READ', 'UPDATE', 'DELETE', 'EXECUTE', 'GET', 'POST', 'PATCH', 'PUT',
          'JS', 'MB', 'KB', 'px', 'ms', 'mm', 'B', 'AND', 'OR', 'null', 'TOAST', 'REST APIs', 'Idempotency-Key', 'SQLSTATE:', '· PostgreSQL',
          // Identifiers a template shows as code: the record variable, $VAR.*, the totalbase schema, the SQL Console's font size buttons.
          'record', '$VAR.', 'totalbase', 'A-', 'A+'
        ]
      }]
    }
  }
)
