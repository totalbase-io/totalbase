/**
 * Workflow definition limits (Workflows.md §3.6), checked on
 * every save - create, draft save, Save as - and again on publish, so a
 * definition written through the Admin API is bounded like one built in
 * the editor. The editor reads the same values to refuse or warn before
 * saving; the server's check (@totalbase/workflows) stays the authority.
 *
 * The global request limits (`api.max_body_bytes`, ...) still apply first.
 */
export const WORKFLOW_DEFINITION_LIMITS = {
  /** Operations per workflow, Start included. */
  maxOperations: 100,
  maxConnections: 200,
  /** UTF-8 bytes of one operation's `JSON.stringify(configuration)`. */
  maxConfigurationBytes: 65_536,
  /** UTF-8 bytes of the whole serialized definition. */
  maxDefinitionBytes: 1_048_576,
  /** Levels of objects/arrays in a configuration, the configuration object itself being 1. */
  maxConfigurationDepth: 20,
  /** Keys of any one object in a configuration (Update records' `set`, HTTP headers, ...). */
  maxMapFields: 100,
  /** Characters of one template path, `{{path}}` (§4.1). */
  maxTemplatePathLength: 1_024,
} as const;
