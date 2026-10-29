/**
 * A file column's thumbnail in a list (DataViews.md §4, Administration.md §10.8): the image transformation a grid's
 * file cell asks for, and the one the server makes in the background once an image is stored - the same parameters,
 * so the same cached derivative, already there when the list first shows it.
 */
export const FILE_THUMBNAIL = { width: 80, fit: "cover" } as const;

/** FILE_THUMBNAIL as the content route's query. */
export const FILE_THUMBNAIL_QUERY: Record<string, string> = { width: String(FILE_THUMBNAIL.width), fit: FILE_THUMBNAIL.fit };
