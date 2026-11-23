/** A search's words (Data_API.md §3.5): each is matched on its own - the parser counts them, the compiler matches them. */
export function searchTerms(search: string): string[] {
  return search.trim().split(/\s+/).filter((term) => term.length > 0);
}
