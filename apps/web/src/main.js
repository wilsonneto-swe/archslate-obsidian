// The web version: the editor in a plain page, the document kept in this
// browser's localStorage. Nothing is uploaded: files are opened and saved
// through the browser (a file picker, drag and drop, a download).
//
// A diagram is saved as the same Markdown note the Obsidian plugin keeps in a
// vault, so a file goes back and forth between the two.
//
// Several tabs share the one stored diagram. Every write carries a new
// revision; a tab remembers the revision it last read or wrote. When another
// tab writes, the others show what it wrote (the `storage` event), and a tab
// that missed that never writes over it: it shows the stored diagram instead
// (its own text stays one Undo away). A tab closes without writing unless it
// has a change not yet stored.

import { DiagramEditor } from '../../../packages/ui/editor.js';
import { newEnvelope, readDiagramFile, serializeNote, slimEnvelope } from '../../../packages/core/document.js';
import { downloadBlob } from '../../../packages/ui/export.js';
import { EXAMPLE_DOCUMENT } from './example.js';

const DOCUMENT_KEY = 'archslate:web:document';
const LEGACY_DOCUMENT_KEY = 'sd:web:document';
const RECOVERED_KEY = 'archslate:web:recovered';
const THEME_KEY = 'archslate:web:theme';

// What surrounds the diagram in the note it came from (its frontmatter, its
// line endings...), so saving it again keeps them. null: a new note.
let envelope = null;
let revision = null;
let editor = null;

const newRevision = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function parseStored(raw) {
  try {
    const stored = JSON.parse(raw);
    if (typeof stored?.text === 'string' && Array.isArray(stored.snapshots)) return stored;
  } catch {
    // corrupt or missing
  }
  return null;
}

function readKey(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage is blocked: the diagram lasts for this visit
  }
}

function readStored() {
  for (const key of [DOCUMENT_KEY, LEGACY_DOCUMENT_KEY]) {
    const stored = parseStored(readKey(key));
    if (stored) return stored;
  }
  return null;
}

const revisionOf = (stored) => (typeof stored?.revision === 'string' ? stored.revision : null);

// Takes a stored document as this tab's own.
function adopt(stored) {
  envelope = slimEnvelope(stored.envelope);
  revision = revisionOf(stored);
  return { text: stored.text, snapshots: stored.snapshots };
}

const host = {
  async load() {
    const stored = readStored();
    return stored ? adopt(stored) : structuredClone(EXAMPLE_DOCUMENT);
  },
  save(doc) {
    const stored = parseStored(readKey(DOCUMENT_KEY));
    if (stored && revisionOf(stored) !== revision) {
      if (editor?.applyExternal(adopt(stored))) editor.notify('This diagram was changed in another tab, so that version is shown now. Undo brings back yours.');
      return;
    }
    const next = newRevision();
    try {
      localStorage.setItem(DOCUMENT_KEY, JSON.stringify({ text: doc.text, snapshots: doc.snapshots, envelope: slimEnvelope(envelope), revision: next }));
      revision = next;
    } catch (error) {
      editor?.notify(`Could not keep the diagram in this browser: ${error.message}`, { error: true });
    }
  },
  serializeDocument(doc) {
    return serializeNote(doc, envelope ?? newEnvelope());
  },
  appleKeys: /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? ''),
};

// Another tab stored a change: show it here too.
window.addEventListener('storage', (event) => {
  if (event.key !== DOCUMENT_KEY || !editor) return;
  const stored = parseStored(event.newValue);
  if (!stored || revisionOf(stored) === revision) return;
  if (editor.applyExternal(adopt(stored))) editor.notify('Updated from another tab.');
});

// ------------------------------------------------------------------- theme

const themeButton = document.getElementById('toggle-theme');
function showTheme() {
  themeButton.textContent = document.documentElement.dataset.theme === 'dark' ? 'Light' : 'Dark';
}
showTheme();
themeButton.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // the choice lasts for this visit only
  }
  showTheme();
});

// ----------------------------------------------------------- open and save

function hasWork() {
  const { text, snapshots } = editor.document;
  return text.trim() !== '' || snapshots.length > 0;
}

function replaceDocument(doc, nextEnvelope, what) {
  const versions = editor.document.snapshots.length;
  const lost = versions ? ` and its ${versions} saved version${versions === 1 ? '' : 's'}` : '';
  if (hasWork() && !window.confirm(`Replace the current diagram${lost} with ${what}? Save it first to keep it.`)) return false;
  envelope = nextEnvelope;
  // The user chose to replace what is stored, whichever tab wrote it.
  revision = revisionOf(parseStored(readKey(DOCUMENT_KEY)));
  editor.openDocument(doc);
  return true;
}

async function openFile(file) {
  if (!editor) return;
  let opened;
  try {
    opened = readDiagramFile(await file.text(), file.name);
  } catch (error) {
    editor.notify(error.message, { error: true });
    return;
  }
  const { doc } = opened;
  if (replaceDocument(doc, opened.envelope, `“${file.name}”`)) {
    const count = doc.snapshots.length;
    editor.notify(`Opened ${file.name}${count ? ` with ${count} saved version${count === 1 ? '' : 's'}` : ''}.`);
  }
}

const fileInput = document.getElementById('file-input');
document.getElementById('open-file').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const [file] = fileInput.files;
  fileInput.value = '';
  if (file) await openFile(file);
});

document.getElementById('save-file').addEventListener('click', () => void editor?.exportDocument());

document.getElementById('reset-example').addEventListener('click', () => {
  if (editor && replaceDocument(structuredClone(EXAMPLE_DOCUMENT), null, 'the example')) editor.notify('The example is back.');
});

// Drag a file anywhere onto the page to open it.
const dropHint = document.getElementById('drop');
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  dragDepth += 1;
  dropHint.hidden = false;
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropHint.hidden = true;
});
window.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
window.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropHint.hidden = true;
  const [file] = event.dataTransfer.files;
  if (file) await openFile(file);
});

// ------------------------------------------------------------------- start

// The stored diagram could not be shown. It is set aside (never overwritten),
// offered as a file, and the example opens so the page works.
function recover(error) {
  console.error(error);
  const stored = readStored();
  const notice = document.getElementById('recovered');
  if (stored) {
    try {
      localStorage.setItem(RECOVERED_KEY, JSON.stringify(stored));
    } catch {
      // the download below still has it
    }
    const note = serializeNote({ text: stored.text, snapshots: stored.snapshots }, slimEnvelope(stored.envelope) ?? newEnvelope());
    document.getElementById('recovered-download').addEventListener('click', () => downloadBlob(new Blob([note], { type: 'text/markdown' }), 'recovered-diagram.md'));
    notice.hidden = false;
  }
  envelope = null;
  revision = revisionOf(parseStored(readKey(DOCUMENT_KEY)));
  editor.setDocument(structuredClone(EXAMPLE_DOCUMENT));
}

document.getElementById('recovered-close').addEventListener('click', () => {
  document.getElementById('recovered').hidden = true;
});

editor = new DiagramEditor(document.getElementById('app'), host);
try {
  await editor.init();
} catch (error) {
  recover(error);
}

// Handy for poking at things from the console.
window.diagramEditor = editor;
