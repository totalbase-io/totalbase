<script setup lang="ts">
/**
 * The sign-in page's own illustration (Admin_UI.md §3.6, the SPLIT layout): PostgreSQL - the
 * TotalBase mark - at the center, and around it what TotalBase builds from it: a REST endpoint, a DataView, a
 * Dashboard and a Workflow, each a small card joined to the center. Hand-written SVG in the theme's classes,
 * so it follows the primary color and light or dark mode; no image file.
 */
</script>

<template>
  <svg
    viewBox="0 0 520 260"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <!-- Links from the center to each card. -->
    <g
      stroke="currentColor"
      stroke-width="1.5"
      stroke-dasharray="4 5"
      class="text-primary/40"
    >
      <path d="M214 112 C 190 100, 170 84, 146 72" />
      <path d="M306 112 C 330 100, 350 84, 374 72" />
      <path d="M214 148 C 190 160, 170 176, 146 188" />
      <path d="M306 148 C 330 160, 350 176, 374 188" />
    </g>

    <!-- The center: PostgreSQL, as the mark, on a soft disc. -->
    <circle
      cx="260"
      cy="130"
      r="46"
      class="fill-primary/10"
    />
    <g transform="translate(228 98) scale(2)">
      <path
        class="fill-primary"
        fill-rule="evenodd"
        d="M16 2c7.7 0 13 2.5 13 6v16c0 3.5-5.3 6-13 6S3 27.5 3 24V8c0-3.5 5.3-6 13-6Zm-7 7.5h14a1.5 1.5 0 0 0 0-3H9a1.5 1.5 0 0 0 0 3Zm5.5 2V24a1.5 1.5 0 0 0 3 0V11.5h-3Z"
      />
    </g>

    <!-- REST API: an endpoint card (top left). -->
    <g transform="translate(36 30)">
      <rect
        width="110"
        height="62"
        rx="8"
        class="fill-elevated stroke-primary/60"
        stroke-width="1.5"
      />
      <rect
        x="10"
        y="10"
        width="28"
        height="12"
        rx="4"
        class="fill-primary/20"
      />
      <text
        x="24"
        y="19"
        text-anchor="middle"
        class="fill-primary text-[7px] font-bold"
        style="font-family: inherit;"
      >GET</text>
      <rect
        x="44"
        y="13"
        width="44"
        height="6"
        rx="2"
        class="fill-primary/30"
      />
      <circle
        cx="98"
        cy="16"
        r="3"
        class="fill-success"
      />
      <rect
        x="10"
        y="32"
        width="70"
        height="6"
        rx="2"
        class="fill-primary/15"
      />
      <rect
        x="10"
        y="44"
        width="50"
        height="6"
        rx="2"
        class="fill-primary/15"
      />
    </g>
    <text
      x="36"
      y="110"
      class="fill-muted text-[11px] font-medium"
      style="font-family: inherit;"
    >REST APIs</text>

    <!-- Dashboard: bars and a line (top right). -->
    <g transform="translate(374 30)">
      <rect
        width="110"
        height="62"
        rx="8"
        class="fill-elevated stroke-primary/60"
        stroke-width="1.5"
      />
      <g class="fill-primary/25">
        <rect
          x="14"
          y="34"
          width="10"
          height="18"
          rx="2"
        />
        <rect
          x="30"
          y="24"
          width="10"
          height="28"
          rx="2"
        />
        <rect
          x="46"
          y="30"
          width="10"
          height="22"
          rx="2"
        />
        <rect
          x="62"
          y="16"
          width="10"
          height="36"
          rx="2"
        />
        <rect
          x="78"
          y="22"
          width="10"
          height="30"
          rx="2"
        />
      </g>
      <path
        d="M14 30 L 35 20 L 51 26 L 67 12 L 83 18"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-primary"
      />
    </g>
    <text
      x="374"
      y="110"
      class="fill-muted text-[11px] font-medium"
      style="font-family: inherit;"
    >Dashboards</text>

    <!-- DataView: a grid (bottom left). -->
    <g transform="translate(36 168)">
      <rect
        width="110"
        height="62"
        rx="8"
        class="fill-elevated stroke-primary/60"
        stroke-width="1.5"
      />
      <rect
        x="1"
        y="1"
        width="108"
        height="16"
        rx="7"
        class="fill-primary/10"
      />
      <g class="fill-primary/40">
        <rect
          x="10"
          y="6"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="44"
          y="6"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="78"
          y="6"
          width="22"
          height="6"
          rx="2"
        />
      </g>
      <g class="fill-primary/15">
        <rect
          x="10"
          y="26"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="44"
          y="26"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="78"
          y="26"
          width="16"
          height="6"
          rx="2"
        />
        <rect
          x="10"
          y="38"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="44"
          y="38"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="78"
          y="38"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="10"
          y="50"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="44"
          y="50"
          width="22"
          height="6"
          rx="2"
        />
        <rect
          x="78"
          y="50"
          width="12"
          height="6"
          rx="2"
        />
      </g>
    </g>
    <text
      x="36"
      y="248"
      class="fill-muted text-[11px] font-medium"
      style="font-family: inherit;"
    >DataViews</text>

    <!-- Workflow: three steps, the first done (bottom right). -->
    <g transform="translate(374 168)">
      <rect
        width="110"
        height="62"
        rx="8"
        class="fill-elevated stroke-primary/60"
        stroke-width="1.5"
      />
      <path
        d="M30 31 L 45 31 M 65 31 L 80 31"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray="3 4"
        class="text-primary/40"
      />
      <circle
        cx="20"
        cy="31"
        r="9"
        class="fill-primary stroke-primary"
        stroke-width="1.5"
      />
      <path
        d="M16 31 L19 34 L25 27"
        stroke="white"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        cx="55"
        cy="31"
        r="9"
        class="fill-primary/15 stroke-primary"
        stroke-width="1.5"
      />
      <circle
        cx="90"
        cy="31"
        r="9"
        class="fill-primary/15 stroke-primary"
        stroke-width="1.5"
      />
    </g>
    <text
      x="374"
      y="248"
      class="fill-muted text-[11px] font-medium"
      style="font-family: inherit;"
    >Workflows</text>
  </svg>
</template>
