// Hand-drawn 24x24 line icons, one path per icon, stroked with currentColor.

import { svg } from './dom.js';

const circle = (cx, cy, r) => {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
};

export const KIND_ICONS = {
  client: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5zM3 9h18M6 6.5h.01M8.5 6.5h.01',
  mobile: 'M8.5 2.5h7A1.5 1.5 0 0 1 17 4v16a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20V4a1.5 1.5 0 0 1 1.5-1.5zM11 18.5h2',
  user: `${circle(12, 8, 4)}M4.5 21c.6-4 3.6-6.5 7.5-6.5s6.9 2.5 7.5 6.5`,
  dns: 'M12 3v18M12 5.5h6l2 2-2 2h-6M12 12H6l-2 2 2 2h6M9 21h6',
  cdn: `${circle(12, 12, 9)}M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z`,
  lb: `${circle(5, 12, 2.5)}${circle(19, 5, 2.5)}${circle(19, 12, 2.5)}${circle(19, 19, 2.5)}M7.5 12h9M7.2 10.8l9.4-4.6M7.2 13.2l9.4 4.6`,
  gateway: 'M4 3.5v17M20 3.5v17M8 12h8M13 8.5l3.5 3.5-3.5 3.5',
  ratelimiter: `${circle(12, 15, 1.6)}M4.2 18a8.5 8.5 0 1 1 15.6 0M13.2 13.8l3.3-4.3M5.5 11.5l1.4.8M12 6.5v1.6M18.5 11.5l-1.4.8`,
  service: 'M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5zM12 12l8.5-4.75M12 12v9.5M12 12L3.5 7.25',
  worker: `${circle(12, 12, 3)}${circle(12, 12, 7)}M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.75 1.75M16.95 16.95l1.75 1.75M5.3 18.7l1.75-1.75M16.95 7.05l1.75-1.75`,
  function: 'M7 4h2.5L17 20h2.5M12.3 10L6.5 20',
  cron: `${circle(12, 12, 9)}M12 7v5l3.5 2`,
  db: 'M4 5.5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  cache: 'M13 2.5L5 13.5h6l-1 8 8-11h-6z',
  storage: 'M4 7h16M5.5 7l1.6 13.5h9.8L18.5 7M8.5 7a3.5 3.5 0 0 1 7 0',
  search: `${circle(10.5, 10.5, 6.5)}M15.5 15.5L21 21`,
  warehouse: 'M3 9.5L12 4l9 5.5V20H3zM7 20v-7h10v7M7 16.5h10',
  coordinator: `${circle(12, 5, 2.5)}${circle(5, 18, 2.5)}${circle(19, 18, 2.5)}M10.8 7.2l-4.6 8.6M13.2 7.2l4.6 8.6M7.5 18h9`,
  queue: 'M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5zM9 7v10M15 7v10',
  topic: `${circle(12, 12, 2)}M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2`,
  stream: 'M3 7c2.2-2 4.3-2 6 0s3.8 2 6 0 4.3-2 6 0M3 12c2.2-2 4.3-2 6 0s3.8 2 6 0 4.3-2 6 0M3 17c2.2-2 4.3-2 6 0s3.8 2 6 0 4.3-2 6 0',
  external: 'M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.6a4.45 4.45 0 0 1-.5 8.9z',
  group: 'M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
};

export const UI_ICONS = {
  plus: 'M12 5v14M5 12h14',
  link: 'M5 12h11M12 7l5 5-5 5',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5',
  pencil: 'M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  swap: 'M7 7h12M15 3l4 4-4 4M17 17H5M9 13l-4 4 4 4',
  close: 'M6 6l12 12M18 6L6 18',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  zoomIn: `${circle(11, 11, 7)}M11 8v6M8 11h6M16.5 16.5L21 21`,
  zoomOut: `${circle(11, 11, 7)}M8 11h6M16.5 16.5L21 21`,
  right: 'M4 12h14M13 7l5 5-5 5',
  down: 'M12 4v14M7 13l5 5 5-5',
  ungroup: 'M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM9 13h6',
  bookmark: 'M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1z',
  diff: `${circle(6, 6, 2.5)}${circle(18, 18, 2.5)}M6 8.5V15a3 3 0 0 0 3 3h6.5M18 15.5V9a3 3 0 0 0-3-3H8.5`,
  help: `${circle(12, 12, 9)}M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01`,
  restore: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  back: 'M19 12H5M10 7l-5 5 5 5',
  code: 'M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5',
  note: 'M5 4h14v10l-6 6H5zM13 20v-6h6',
  details: `${circle(15, 7, 2)}${circle(9, 17, 2)}M4 7h9M17 7h3M4 17h3M11 17h9`,
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  flow: `${circle(6, 6, 2.5)}${circle(18, 18, 2.5)}M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5`,
  doc: 'M6.5 3.5H14l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5zM14 3.5V8h4M9 12h6M9 15.5h6',
  image: `${circle(15.5, 8.5, 1.5)}M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 16l4.5-4.5 4 4 2.5-2.5L20 18`,
  panel: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM15 4v16',
  chevronDown: 'M6 9l6 6 6-6',
};

export function icon(name, size = 16, className = 'sd-icon') {
  const d = KIND_ICONS[name] ?? UI_ICONS[name];
  return svg(
    'svg',
    {
      class: className,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    svg('path', { d }),
  );
}
