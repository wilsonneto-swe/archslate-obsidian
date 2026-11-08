// Side panel showing the markdown written below the diagram's "---" line,
// rendered. It belongs to whatever version is on screen, so viewing an old
// version shows the notes as they were then.

import { el } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';

export class NotesPanel {
  constructor(editor) {
    this.editor = editor;
    this.rendered = null;
    this.body = el('div', { class: 'sd-notes-body sd-md' });
    this.changed = el('span', { class: 'sd-chip is-changed', text: 'changed', title: 'Different from the version being compared', hidden: true });
    this.editButton = el(
      'button',
      { type: 'button', class: 'sd-btn sd-btn-icon', title: 'Edit in the source', 'aria-label': 'Edit notes in the source', onclick: () => editor.editMarkdown() },
      icon('pencil', 14),
    );
    this.root = el(
      'aside',
      { class: 'sd-notes-panel', 'aria-label': 'Notes', hidden: true },
      el(
        'header',
        { class: 'sd-pane-header' },
        el('span', { class: 'sd-pane-title', text: 'Notes' }),
        this.changed,
        el('span', { class: 'sd-spacer' }),
        this.editButton,
        el(
          'button',
          { type: 'button', class: 'sd-btn sd-btn-icon', title: 'Hide notes (M)', 'aria-label': 'Hide notes', onclick: () => editor.toggleNotes(false) },
          icon('close', 14),
        ),
      ),
      this.body,
    );
  }

  update({ markdown, open, changed, readOnly }) {
    this.root.hidden = !open;
    this.changed.hidden = !changed;
    this.editButton.hidden = readOnly;
    const key = `${readOnly}\u0000${markdown}`;
    if (!open || key === this.rendered) return;
    this.rendered = key;
    if (markdown.trim() === '') {
      const hint = el('p', { class: 'sd-muted' }, 'Nothing here yet. Everything you write below a ', el('code', { text: '---' }), ' line in the source shows up here, and is saved with each version.');
      const start = el('button', { type: 'button', class: 'sd-btn sd-primary', onclick: () => this.editor.editMarkdown() }, icon('pencil', 14), el('span', { text: 'Start writing' }));
      this.body.replaceChildren(...(readOnly ? [hint] : [hint, start]));
      return;
    }
    const render = this.editor.host.renderMarkdown;
    if (render) {
      this.body.replaceChildren();
      render(markdown, this.body);
    } else {
      this.body.replaceChildren(renderMarkdown(markdown));
    }
  }
}
