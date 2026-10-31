// Design principles: Admin_UI.md §1.2 — simple, sober,
// professional, table-oriented. Reference style: Tailscale Admin, GitHub
// Settings. Sky/slate (Nuxt UI's dashboard template) keeps that register instead of a CMS-like green.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'sky',
      neutral: 'slate',
      // Nuxt UI's default info is sky, the same hue as primary now: blue keeps an
      // info badge or toast apart from a primary one.
      info: 'blue',
      // Left at Nuxt UI's default (a blue near-identical to primary)
      // until now - violet gives resource-type.ts's FUNCTION color (and
      // any other "distinct third category" use) a hue that doesn't
      // double up on primary.
      secondary: 'violet'
    },
    // A modal's and a sidebar's header read like a drawer's: the title takes
    // the width, then any header actions (a record's "⋮"), then Close - in the
    // flow rather than pinned over the corner, so an action never sits by
    // the title or under the X. Merged over the theme's own classes.
    modal: {
      slots: { wrapper: 'flex-1 min-w-0', close: 'static' }
    },
    // A splitter's handle is an invisible drag area in the theme: drawn here as
    // a hairline in the border color, primary on hover and while dragging -
    // so a viewer sees there's something to drag. Every USplitter follows.
    splitter: {
      slots: {
        handle: 'after:absolute after:bg-(--ui-border) hover:after:bg-primary data-[resize-handle-state=drag]:after:bg-primary after:transition-colors'
      },
      variants: {
        orientation: {
          horizontal: { handle: 'after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2' },
          vertical: { handle: 'after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2' }
        }
      }
    },
    slideover: {
      slots: { wrapper: 'flex-1 min-w-0', close: 'static' }
    },
    // A calendar's days of the month read apart from the neighbouring months': the theme leaves them at
    // text-default against text-muted, near-identical in slate at a small size. The month's days highlighted,
    // the others dimmed; disabled and selected days keep the theme's own (their data-* classes win).
    calendar: {
      slots: { cellTrigger: 'text-highlighted' },
      variants: {
        view: {
          day: { cellTrigger: 'data-outside-view:text-dimmed' }
        }
      }
    },
    // A row of option cards (Settings' choices, any horizontal card group): equal parts of the row, whatever each
    // one's text - one card's words never squeezed one per line beside a wide one. Stacked, as they are below md, each
    // takes the whole width.
    radioGroup: {
      compoundVariants: [{ variant: 'card', orientation: 'horizontal', class: { item: 'min-w-0 md:flex-1 md:basis-0' } }]
    },
    // Every UTable as in Nuxt UI's dashboard template: the header a rounded strip with a border on a soft
    // background, 40 px, its labels small and semibold; rows of 44 px with a rule under each but the last (a
    // DataView's Compact and Very compact densities narrow them). Light and dark from the theme's tokens.
    table: {
      slots: {
        base: 'border-separate border-spacing-0',
        thead: '[&>tr]:bg-elevated/50 [&>tr]:after:content-none',
        tbody: '[&>tr]:last:[&>td]:border-b-0',
        // Whole pixels (the root is 15px, so h-10 would be 37.5): a fractional header blurs its rule into two lines.
        th: 'h-[40px] py-1 text-xs font-semibold text-default border-y border-default first:rounded-l-lg last:rounded-r-lg first:border-l last:border-r',
        td: 'h-[44px] py-2 border-b border-default',
        separator: 'h-0'
      }
    },
    // The group panel (layouts/default.vue): shown or not by the layout (useCompactUi), not by a breakpoint;
    // folds to nothing; our own 72 px SidebarHeader; the soft background of the shell's hierarchy.
    dashboardSidebar: {
      slots: {
        root: 'flex min-h-0 min-w-0 bg-elevated/25',
        header: 'h-auto px-0 [&>*]:min-w-0 [&>*]:flex-1',
        body: 'gap-0 p-2',
        // Its menu (a phone's or a tablet's navigation) opens whenever the layout asks, at any width.
        content: 'lg:flex max-w-sm',
        overlay: 'lg:block'
      }
    },
    // The ☰ shows whenever the page's navbar is given it (PageShell: on a phone or a tablet), not by a breakpoint.
    dashboardSidebarToggle: { base: '' },
    // A page fills the layout's <main>, not the viewport; its navbar is --admin-header-height tall (main.css sets
    // --ui-header-height to it) with the rule inside that height, so it lines up with the panel's and the rail's.
    dashboardPanel: {
      slots: { root: 'min-h-0 h-full' }
    },
    // PageHeader is every page's navbar: laid out as a grid by main.css (.page-header--standard/--editor - the
    // title truncates before the actions do, the center stays centered); the center from md, like before.
    dashboardNavbar: {
      slots: {
        root: 'border-b-0 shadow-[inset_0_-1px_0_var(--ui-border)]',
        left: 'min-w-0 gap-3',
        center: 'hidden md:flex justify-self-center',
        // page-header__actions: the row PageHeader's CSS (main.css) sizes an editor's controls in.
        right: 'page-header__actions justify-self-end gap-2'
      }
    },
    // The admin's vertical UNavigationMenus are its side panels (the rail's
    // second column, the App menu, the mobile slideover): breathing room
    // between items, subgroup labels as small uppercase headings, a soft
    // rule between sections. Merged over the theme's own classes.
    navigationMenu: {
      slots: {
        separator: 'my-3 bg-default border-t border-default',
        label: 'px-2.5 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted'
      },
      // The side panels' trees; a horizontal menu (a settings page's sections) keeps the theme's row.
      variants: {
        orientation: {
          vertical: {
            list: 'flex flex-col gap-1',
            link: 'ps-3.5 py-2',
            childList: 'ms-7 border-s-0'
          }
        }
      }
    },
    // Phone width: horizontal tabs keep their full labels and scroll
    // sideways, instead of every tab shrinking to a truncated "P…". The
    // scrolling list clips what hangs below it, so the link variant's
    // active underline moves up onto the list's own bottom edge there.
    // The upload area in the theme's looks (Admin_UI.md §4.2): Nuxt UI's variant is only area (outlined, dashed) or
    // button; soft and subtle are the area in its color's tint, as an Input's or a Badge's - the component renders
    // any variant but button as the area, and the theme's extend adds the keys at runtime.
    fileUpload: {
      variants: {
        variant: {
          soft: { wrapper: 'px-4 py-3', base: 'p-4 border-transparent' },
          subtle: { wrapper: 'px-4 py-3', base: 'p-4' }
        }
      },
      compoundVariants: [
        { variant: 'soft', color: 'primary', class: { base: 'bg-primary/10' } },
        { variant: 'soft', color: 'secondary', class: { base: 'bg-secondary/10' } },
        { variant: 'soft', color: 'success', class: { base: 'bg-success/10' } },
        { variant: 'soft', color: 'info', class: { base: 'bg-info/10' } },
        { variant: 'soft', color: 'warning', class: { base: 'bg-warning/10' } },
        { variant: 'soft', color: 'error', class: { base: 'bg-error/10' } },
        { variant: 'soft', color: 'neutral', class: { base: 'bg-elevated/50' } },
        { variant: 'subtle', color: 'primary', class: { base: 'bg-primary/10 border-primary/25' } },
        { variant: 'subtle', color: 'secondary', class: { base: 'bg-secondary/10 border-secondary/25' } },
        { variant: 'subtle', color: 'success', class: { base: 'bg-success/10 border-success/25' } },
        { variant: 'subtle', color: 'info', class: { base: 'bg-info/10 border-info/25' } },
        { variant: 'subtle', color: 'warning', class: { base: 'bg-warning/10 border-warning/25' } },
        { variant: 'subtle', color: 'error', class: { base: 'bg-error/10 border-error/25' } },
        { variant: 'subtle', color: 'neutral', class: { base: 'bg-elevated border-accented' } }
      ]
    },
    tabs: {
      variants: {
        orientation: {
          horizontal: {
            list: 'max-md:overflow-x-auto max-md:[scrollbar-width:none]',
            trigger: 'max-md:shrink-0'
          }
        }
      },
      compoundVariants: [{
        orientation: 'horizontal',
        variant: 'link',
        class: { indicator: 'max-md:bottom-0' }
      }]
    }
  }
})
