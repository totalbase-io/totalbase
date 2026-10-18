/**
 * Prints a PDF Blob via a throwaway off-screen `<iframe>`, built with raw
 * DOM calls rather than template markup - unlike DataViewGrid.vue's own
 * printPdf() (which owns one iframe in its template for its whole
 * lifetime), this is called from three different places (the record form's
 * own "Print" action in DataViewRecordPanel.vue and PAGE's new.vue/[pk]/edit.vue)
 * that would otherwise each need to duplicate the same iframe markup +
 * blob-URL bookkeeping just to reuse it once. `#toolbar=0` plus staying
 * off-screen (not display:none, which some browsers won't render a PDF
 * into) keeps it invisible - same reasoning as DataViewGrid.vue's own.
 */
export function usePrintBlob() {
  function printBlob(blob: Blob) {
    const url = URL.createObjectURL(blob)
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.left = '-10000px'
    iframe.style.top = '0'
    iframe.style.width = '600px'
    iframe.style.height = '800px'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.onload = () => iframe.contentWindow?.print()
    iframe.src = `${url}#toolbar=0`
    document.body.appendChild(iframe)
    // Printing itself is async (the browser's own native dialog) with no
    // "done" event to wait for - a generous delay before cleanup rather
    // than trying to detect when the dialog closed.
    setTimeout(() => {
      iframe.remove()
      URL.revokeObjectURL(url)
    }, 60_000)
  }
  return { printBlob }
}
