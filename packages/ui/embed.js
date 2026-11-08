// A diagram drawn once, read-only: what Obsidian shows for an ```archslate
// code block in a note (reading view and live preview). No editor, no pan or
// zoom: the picture scales to the width it is given.

import { parse } from '../core/parser.js';
import { layoutDiagram } from '../core/layout.js';
import { el } from './dom.js';
import { createMeasurer } from './measure.js';
import { DiagramRenderer } from './renderer.js';

const PADDING = 16;

export function renderDiagram(container, source) {
  const model = parse(source);
  const root = el('div', { class: 'sd-embed' });
  container.append(root);

  if (model.nodes.length === 0 && model.groups.length === 0) {
    root.append(el('div', { class: 'sd-embed-empty', text: model.errors.length ? 'This diagram has errors and nothing to draw yet.' : 'Empty diagram.' }));
  } else {
    const layout = layoutDiagram(model, { measureText: createMeasurer(root) });
    const renderer = new DiagramRenderer();
    renderer.update(model, layout);
    const { x, y, w, h } = layout.bounds;
    const svg = renderer.svg;
    svg.setAttribute('viewBox', `${x - PADDING} ${y - PADDING} ${w + 2 * PADDING} ${h + 2 * PADDING}`);
    svg.setAttribute('width', String(Math.ceil(w + 2 * PADDING)));
    svg.setAttribute('aria-label', `Diagram with ${model.nodes.length} components`);
    svg.classList.add('sd-embed-svg');
    root.append(svg);
  }

  if (model.errors.length) {
    root.append(
      el(
        'ul',
        { class: 'sd-embed-errors' },
        model.errors.slice(0, 5).map((error) => el('li', { text: `Line ${error.line + 1}: ${error.message}` })),
        model.errors.length > 5 ? el('li', { text: `and ${model.errors.length - 5} more` }) : null,
      ),
    );
  }
  return { root, model };
}
