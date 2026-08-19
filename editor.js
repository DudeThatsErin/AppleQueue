/* eslint-disable */
// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT HERE.
//
// Copied from the dashboard's src/shared/editor.js by `npm run sync-editor`.
// Edit it there and re-run the script; changes made in this copy will be
// overwritten and will silently put the extension out of step with the site.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The note editor, shared verbatim by the dashboard and the Apple Queue
 * browser extension.
 *
 * This file is the single source of truth for both. It lives here; the
 * extension gets a copy via `npm run sync-editor`. Edit it in one place only —
 * the copy in the extension repo is generated and carries a header saying so.
 *
 * Plain ES module with no imports on purpose. The two hosts get `marked` and
 * `TurndownService` from different places (npm on the dashboard, vendored
 * globals in the extension), so they are injected rather than imported.
 *
 * The value in and out is always markdown. contentEditable only speaks HTML,
 * so the WYSIWYG surface converts on the way in and on the way out — but
 * markdown is the stored format, the wire format, and what Apple Notes is
 * given, because that is the format Notes actually interprets.
 */

/* ── Markdown conversion ──────────────────────────────────────────────────
 * Both hosts build these from the same rules, so a note round-trips
 * identically no matter where it was typed.
 */

export function createMarkdownTools({ marked, TurndownService }) {
  let turndown = null;

  function service() {
    if (turndown) return turndown;
    turndown = new TurndownService({
      headingStyle: 'atx',        // "## Heading", not underlines
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
    });

    // contentEditable emits <div> for new lines in some browsers; treat it as
    // a block so paragraphs don't run together.
    turndown.addRule('div', {
      filter: 'div',
      replacement: (content) => `\n\n${content}\n\n`,
    });

    // A <pre> with no nested <code> — what execCommand('formatBlock', 'pre')
    // and some pasted HTML produce. Turndown's built-in fenced-code rule only
    // matches <pre><code>, so without this the block degrades to plain text
    // and the fences never reach Notes.
    turndown.addRule('bareCodeBlock', {
      filter: (node) =>
        node.nodeName === 'PRE' && (!node.firstChild || node.firstChild.nodeName !== 'CODE'),
      replacement: (content, node) =>
        `\n\n\`\`\`\n${node.textContent.replace(/\n+$/, '')}\n\`\`\`\n\n`,
    });

    // Task list items. Turndown would otherwise drop the input entirely and
    // leave a plain bullet, silently losing every checkbox in the note.
    turndown.addRule('taskListItem', {
      filter: (node) =>
        node.nodeName === 'LI' && !!node.querySelector('input[type="checkbox"]'),
      replacement: (content, node) => {
        const box = node.querySelector('input[type="checkbox"]');
        // Clicking a checkbox sets the property but not the attribute, and
        // innerHTML only serialises attributes — the editor keeps the two in
        // step, but check both so a stray input still converts correctly.
        const checked = !!(box && (box.checked || box.hasAttribute('checked')));
        const text = content.replace(/^\s*\[[ xX]\]\s*/, '').trim();
        return `- [${checked ? 'x' : ' '}] ${text}\n`;
      },
    });

    return turndown;
  }

  /** HTML (contentEditable output, or a legacy queued body) -> markdown. */
  function htmlToMarkdown(html) {
    if (!html) return '';
    return service()
      .turndown(html)
      .split('\u200B').join('')   // caret anchors the editor inserts
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * marked renders GFM task-list checkboxes as disabled="" — fine for a
   * read-only preview, wrong for a note you need to actually check off.
   */
  function stripCheckboxDisabled(html) {
    return html.replace(/<input([^>]*type="checkbox"[^>]*)>/gi, (m, attrs) =>
      `<input${attrs.replace(/\s*disabled(="")?/gi, '')}>`
    );
  }

  /**
   * marked closes a fenced block as "...code\n</code></pre>". That newline is
   * an artifact of rendering, not content: it shows as a blank last line, and
   * it makes a freshly loaded code block look like it already ends in an empty
   * line — which would make the very first Enter inside it exit the block.
   */
  function trimCodeBlockNewline(html) {
    return html.replace(/\n(<\/code><\/pre>)/g, '$1');
  }

  /** Markdown -> HTML, for painting a stored body into the WYSIWYG surface. */
  function markdownToHtml(md) {
    if (!md) return '';
    return trimCodeBlockNewline(
      stripCheckboxDisabled(marked.parse(md, { async: false, gfm: true, breaks: true }))
    );
  }

  /**
   * Does this body look like HTML rather than markdown?
   *
   * Needed for the compatibility shim: bodies queued before markdown became
   * the wire format — and anything from an extension that has not been
   * updated yet — are raw HTML. Deliberately conservative, so markdown that
   * merely mentions a "<" is not misread.
   */
  function looksLikeHtml(body) {
    if (!body) return false;
    return /<(p|div|br|ul|ol|li|h[1-6]|strong|b|em|i|a|pre|code|blockquote|table|input)\b[^>]*>/i.test(body);
  }

  /**
   * Normalise any stored body to markdown, whatever it arrived as. This is the
   * wire format: what the queue stores and what the Shortcut is handed.
   */
  function toMarkdown(body) {
    const s = (body || '').trim();
    return looksLikeHtml(s) ? htmlToMarkdown(s) : s;
  }

  return { htmlToMarkdown, markdownToHtml, looksLikeHtml, toMarkdown };
}

/* ── Styles ───────────────────────────────────────────────────────────────
 * Shipped with the component and injected once per document, so the two hosts
 * cannot drift apart visually and there is no stylesheet to keep in sync.
 */

export const EDITOR_CSS = `
.mdx { font-family: 'Google Sans', 'Google Sans Text', 'Google Sans Flex', Arial, sans-serif; border: 1px solid #334155; border-radius: 0.375rem; overflow: hidden; background: #0f172a; }

.mdx-toolbar {
  display: flex; flex-wrap: wrap; gap: 2px; align-items: center;
  padding: 4px; background: #1e293b; border-bottom: 1px solid #334155;
}
.mdx-toolbar button {
  min-width: 26px; height: 26px; padding: 0 6px;
  background: none; border: none; border-radius: 4px;
  color: #fff; font-size: 12px; line-height: 1; cursor: pointer;
}
.mdx-toolbar button:hover:not(:disabled) { background: #253347; color: #fff; }
.mdx-toolbar button.active { background: #0891b2; color: #fff; }
.mdx-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
.mdx-toolbar .mdx-sep { width: 1px; height: 16px; margin: 0 3px; background: #334155; }
.mdx-mode { margin-left: auto; font-weight: 600; width: auto; }

.mdx-surface, .mdx-source {
  padding: 0.6rem 0.7rem; background: #0f172a; color: #e2e8f0;
  font-size: 0.875rem; line-height: 1.6; outline: none;
  width: 100%; box-sizing: border-box;
}
.mdx-source {
  border: 0; resize: vertical; display: block;
  font-family: 'Google Sans', 'Google Sans Text', 'Google Sans Flex', Arial, sans-serif;
  /* Markdown source wraps by default. The toolbar can toggle no-wrap. */
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden;
}
.mdx-source.mdx-nowrap {
  white-space: pre; overflow-wrap: normal; overflow-x: auto;
}
.mdx-surface[data-empty="true"]::before {
  content: attr(data-placeholder); color: #475569; pointer-events: none;
}
.mdx-hidden { display: none !important; }

/* Note typography. Applied to the live editing surface and to .mdx-preview,
 * which is how the pending-queue cards render a queued body — same markdown,
 * so it has to look the same and not fall back to the browser's default
 * margins, which put a blank line around every paragraph. */
.mdx-surface > :first-child, .mdx-preview > :first-child { margin-top: 0; }
.mdx-surface > :last-child, .mdx-preview > :last-child { margin-bottom: 0; }
.mdx-surface p, .mdx-preview p { margin: 0; }
.mdx-surface h1, .mdx-preview h1 { font-size: 1.25rem; margin: 0.3rem 0 0; font-weight: 700; }
.mdx-surface h2, .mdx-preview h2 { font-size: 1.1rem;  margin: 0.3rem 0 0; font-weight: 700; }
.mdx-surface h3, .mdx-preview h3 { font-size: 1rem;    margin: 0.3rem 0 0; font-weight: 600; }
.mdx-surface strong, .mdx-preview strong { font-weight: 700; color: #e2e8f0; }
.mdx-surface em, .mdx-preview em { font-style: italic; }
.mdx-surface ul, .mdx-surface ol,
.mdx-preview ul, .mdx-preview ol { margin: 0; padding-left: 1.6rem; }
/* Nested lists step in, but don't inherit the outer list's bottom margin. */
.mdx-surface li > ul, .mdx-surface li > ol,
.mdx-preview li > ul, .mdx-preview li > ol { margin: 0; }
.mdx-surface li, .mdx-preview li { margin: 0; padding-left: 0.15rem; }
.mdx-surface ul, .mdx-preview ul { list-style: disc; }
.mdx-surface ol, .mdx-preview ol { list-style: decimal; }
.mdx-surface blockquote, .mdx-preview blockquote {
  margin: 0.2rem 0; padding-left: 0.6rem;
  border-left: 3px solid #334155; color: #94a3b8;
}
.mdx-surface pre, .mdx-preview pre {
  margin: 0.2rem 0; padding: 0.5rem; border-radius: 0.25rem;
  background: #1e293b; overflow-x: auto; white-space: pre-wrap;
  font-family: 'Google Sans', 'Google Sans Text', 'Google Sans Flex', Arial, sans-serif; font-size: 0.8rem;
}
/* Inline code and the <code> marked nests inside <pre>: the nested one must
 * not double up the block's background and padding. */
.mdx-surface code, .mdx-preview code {
  background: #1e293b; border-radius: 0.2rem; padding: 0.05rem 0.3rem;
  font-family: 'Google Sans', 'Google Sans Text', 'Google Sans Flex', Arial, sans-serif; font-size: 0.85em;
}
.mdx-surface pre code, .mdx-preview pre code {
  background: none; padding: 0; font-size: inherit;
}
.mdx-surface a, .mdx-preview a { color: #5eead4; }

/* Checklists.
 *
 * A task item is a list item whose bullet IS the checkbox: the marker is
 * suppressed and the box takes its place, with the text just after it like any
 * other list. The list keeps its normal indent, so a checklist lines up with
 * the bullets and numbers around it — including in a mixed list, where zeroing
 * the padding would drag every plain bullet out to the far left.
 * Matched with :has() rather than a class so it applies to marked's output and
 * to items typed by hand, with no post-processing step. */
.mdx-surface li:has(> input[type="checkbox"]) {
  list-style: none;
  display: flex; align-items: flex-start; gap: 0.45rem;
}
/* Fully reset, not just positioned. Both hosts style bare \`input\` globally
 * for their text fields — the dashboard sets width:100% and a padding — and a
 * checkbox inheriting that stretches across the row with the box floating in
 * the middle of it. Every inherited property that can distort it is neutered
 * here rather than assumed absent. */
.mdx-surface li > input[type="checkbox"] {
  flex: 0 0 auto;
  appearance: auto; -webkit-appearance: checkbox;
  box-sizing: border-box;
  width: 15px; min-width: 15px; max-width: 15px;
  height: 15px; min-height: 15px;
  padding: 0; margin: 0.24rem 0 0;
  background: none; border: none; border-radius: 0; box-shadow: none;
  accent-color: #06b6d4;
  cursor: pointer;
}
.mdx-surface li > input[type="checkbox"]:focus {
  outline: 2px solid #06b6d4; outline-offset: 1px; box-shadow: none;
}
`;

/**
 * Add the component's stylesheet to a document, once.
 *
 * Exported because rendered note bodies (.mdx-preview) need these styles too,
 * and a page may show one before any editor has mounted.
 */
export function ensureEditorCss(doc) {
  if (!doc || doc.getElementById('mdx-editor-css')) return;
  const style = doc.createElement('style');
  style.id = 'mdx-editor-css';
  style.textContent = EDITOR_CSS;
  doc.head.appendChild(style);
}

/* ── Editor ───────────────────────────────────────────────────────────────*/

/**
 * `html` labels are markup (the bold B is actually bold); `text` labels are
 * plain strings. The distinction matters: the code-block glyph "</>" assigned
 * as innerHTML is parsed as a bogus end tag and silently dropped, which left
 * that button rendering as an invisible gap in the toolbar.
 */
const TOOLBAR = [
  { cmd: 'bold', html: '<b>B</b>', title: 'Bold' },
  { cmd: 'italic', html: '<i>I</i>', title: 'Italic' },
  { cmd: 'underline', html: '<u>U</u>', title: 'Underline' },
  { cmd: 'strikeThrough', html: '<s>S</s>', title: 'Strikethrough' },
  { sep: true },
  { block: 'h1', text: 'H1', title: 'Heading 1' },
  { block: 'h2', text: 'H2', title: 'Heading 2' },
  { block: 'h3', text: 'H3', title: 'Heading 3' },
  { block: 'p', text: '¶', title: 'Paragraph' },
  { sep: true },
  { cmd: 'insertUnorderedList', text: '•≡', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', text: '1≡', title: 'Numbered list' },
  { checklist: true, text: '☑', title: 'Checklist' },
  { sep: true },
  { block: 'blockquote', text: '❝', title: 'Quote' },
  { block: 'pre', text: '</>', title: 'Code block' },
  { code: true, text: '`', title: 'Inline code' },
  { link: true, text: '🔗', title: 'Link' },
  { cmd: 'removeFormat', text: '⌫', title: 'Clear formatting' },
];

// Zero-width space: a caret anchor inside otherwise-empty markup. Stripped
// on the way out so it never reaches the note.
const ZWSP = '\u200B';

const CHECKBOX_ITEM = '<li><input type="checkbox"> </li>';

/**
 * Mount the editor into `container`.
 *
 * Returns a handle: { getValue, setValue, getMode, setMode, focus, destroy }.
 * `getValue()` is always markdown, whichever surface was used to type it.
 */
export function createEditor(container, options = {}) {
  const {
    marked,
    TurndownService,
    value = '',
    placeholder = 'Content…',
    minHeight = 140,
    mode = 'markdown',
    onChange = () => {},
  } = options;

  const doc = container.ownerDocument;
  const md = createMarkdownTools({ marked, TurndownService });
  ensureEditorCss(doc);

  let currentMode = mode;

  const root = doc.createElement('div');
  root.className = 'mdx';

  const toolbar = doc.createElement('div');
  toolbar.className = 'mdx-toolbar';
  root.appendChild(toolbar);

  const surface = doc.createElement('div');
  surface.className = 'mdx-surface';
  surface.contentEditable = 'true';
  surface.setAttribute('role', 'textbox');
  surface.setAttribute('aria-multiline', 'true');
  surface.dataset.placeholder = placeholder;
  surface.style.minHeight = `${minHeight}px`;
  root.appendChild(surface);

  const source = doc.createElement('textarea');
  source.className = 'mdx-source mdx-hidden';
  source.spellcheck = false;
  source.placeholder = `${placeholder} (markdown)`;
  source.style.minHeight = `${minHeight}px`;
  root.appendChild(source);

  container.appendChild(root);

  /* — helpers — */

  const setSurfaceHtml = (html) => {
    // Parsed in a detached document and imported, rather than assigning
    // innerHTML, so this passes the extension's unsafe-innerHTML lint.
    surface.textContent = '';
    const parsed = new doc.defaultView.DOMParser().parseFromString(html, 'text/html');
    Array.from(parsed.body.childNodes).forEach((n) => surface.appendChild(doc.importNode(n, true)));
    refreshPlaceholder();
  };

  function refreshPlaceholder() {
    surface.dataset.empty = surface.textContent.trim() || surface.querySelector('input,img')
      ? 'false'
      : 'true';
  }

  function currentMarkdown() {
    return currentMode === 'markdown'
      ? source.value
      : md.htmlToMarkdown(surface.innerHTML);
  }

  function emit() {
    refreshPlaceholder();
    onChange(currentMarkdown());
  }

  function exec(cmd, arg) {
    surface.focus();
    doc.execCommand(cmd, false, arg ?? null);
    emit();
  }

  /* — toolbar — */

  const buttons = [];
  for (const item of TOOLBAR) {
    if (item.sep) {
      const sep = doc.createElement('span');
      sep.className = 'mdx-sep';
      toolbar.appendChild(sep);
      continue;
    }
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.title = item.title;
    btn.setAttribute('aria-label', item.title);
    // Only `html` labels go in as markup; text labels are set as text so a
    // glyph containing angle brackets survives.
    if (item.html) btn.innerHTML = item.html;
    else btn.textContent = item.text;
    // mousedown, not click: the default mousedown would move focus out of the
    // surface and collapse the selection before the command could run.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (item.cmd) exec(item.cmd);
      else if (item.block) toggleBlock(item.block);
      else if (item.checklist) insertChecklistItem();
      else if (item.code) toggleInlineCode();
      else if (item.link) {
        const href = doc.defaultView.prompt('Link URL');
        if (href) exec('createLink', href);
      }
    });
    toolbar.appendChild(btn);
    buttons.push(btn);
  }

  // The mode toggle is a real click handler and never disabled — it is the
  // only control that still means something while the markdown source is up.
  const modeBtn = doc.createElement('button');
  modeBtn.type = 'button';
  modeBtn.className = 'mdx-mode';
  modeBtn.title = 'Toggle markdown source';
  modeBtn.textContent = 'Markdown';
  modeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    setMode(currentMode === 'markdown' ? 'wysiwyg' : 'markdown');
  });
  toolbar.appendChild(modeBtn);

  // Markdown source wraps by default. This toggle only changes the source
  // textarea; WYSIWYG already wraps naturally. Wrap always starts enabled on
  // a fresh editor instance, even if the user turned it off last time.
  let sourceWrap = true;
  const wrapBtn = doc.createElement('button');
  wrapBtn.type = 'button';
  wrapBtn.className = 'mdx-wrap active';
  wrapBtn.title = 'Toggle word wrap';
  wrapBtn.setAttribute('aria-label', 'Toggle word wrap');
  wrapBtn.textContent = 'Wrap';
  wrapBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sourceWrap = !sourceWrap;
    source.classList.toggle('mdx-nowrap', !sourceWrap);
    wrapBtn.classList.toggle('active', sourceWrap);
    wrapBtn.setAttribute('aria-pressed', sourceWrap ? 'true' : 'false');
    if (currentMode === 'markdown') source.focus();
  });
  wrapBtn.setAttribute('aria-pressed', 'true');
  toolbar.appendChild(wrapBtn);

  /* — checklists — */

  function insertChecklistItem() {
    surface.focus();
    const li = closestTaskItem();
    // Inside a list already: add a sibling item rather than nesting a new list.
    doc.execCommand('insertHTML', false, li ? CHECKBOX_ITEM : `<ul>${CHECKBOX_ITEM}</ul>`);
    emit();
  }

  /** Nearest ancestor of the caret matching `selector`, within the surface. */
  function closestWithin(selector) {
    const sel = doc.defaultView.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    const hit = node && node.closest ? node.closest(selector) : null;
    return hit && surface.contains(hit) ? hit : null;
  }

  /** The <li> holding the caret, if it is a checkbox item. */
  function closestTaskItem() {
    const li = closestWithin('li');
    if (!li) return null;
    return li.querySelector(':scope > input[type="checkbox"]') ? li : null;
  }

  const BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|PRE|BLOCKQUOTE)$/;

  /**
   * Lift a block's contents out and drop the wrapper.
   *
   * execCommand has no way to undo formatBlock — 'p' on a quoted paragraph
   * just re-wraps inside the blockquote — so the toolbar toggles it by hand.
   * Returns the first resulting block, for placing the caret.
   */
  function unwrapBlock(el) {
    const parent = el.parentNode;
    const blocks = [];
    let inlineRun = null;

    // Collected first: appending elsewhere mutates childNodes as we walk it.
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 1 && BLOCK_TAGS.test(node.nodeName)) {
        inlineRun = null;
        blocks.push(node);
      } else {
        // Loose text and inline markup need a block of their own once the
        // wrapper is gone, or they merge into whatever precedes the quote.
        if (!inlineRun) {
          inlineRun = doc.createElement('p');
          blocks.push(inlineRun);
        }
        inlineRun.appendChild(node);
      }
    }

    if (!blocks.length) {
      const p = doc.createElement('p');
      p.appendChild(doc.createElement('br'));
      blocks.push(p);
    }
    blocks.forEach((b) => parent.insertBefore(b, el));
    el.remove();
    return blocks[0];
  }

  /**
   * Wrap the selection in inline code, or unwrap it if it already is.
   *
   * execCommand has no inline-code command, so the element is built by hand.
   * Turndown renders <code> as single backticks, which Notes accepts the same
   * way it accepts a triple-backtick block.
   */
  function toggleInlineCode() {
    surface.focus();
    const existing = closestWithin('code');
    if (existing && !existing.closest('pre')) {
      const parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      existing.remove();
      emit();
      return;
    }

    const sel = doc.defaultView.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const code = doc.createElement('code');
    if (range.collapsed) {
      // Nothing selected: drop in an empty span and put the caret inside it.
      code.appendChild(doc.createTextNode(ZWSP));
      range.insertNode(code);
      placeCaret(code.firstChild, 1);
    } else {
      code.appendChild(range.extractContents());
      range.insertNode(code);
      placeCaret(code, code.childNodes.length);
    }
    emit();
  }

  /**
   * Turn the current block into a fenced code block.
   *
   * Built by hand rather than with execCommand('formatBlock', 'pre'), which
   * produces a bare <pre> with no nested <code>. Turndown's fenced-code rule
   * only matches <pre><code>, so a bare one converts to ordinary paragraph
   * text — the toolbar button looked right on screen and then saved as plain
   * text, while the same thing typed as ``` in markdown mode saved correctly.
   */
  function applyCodeBlock() {
    const sel = doc.defaultView.getSelection();
    const host = closestWithin('p, div, h1, h2, h3, h4, h5, h6, li');

    let text = '';
    if (host) text = host.textContent;
    else if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) text = sel.getRangeAt(0).toString();

    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.textContent = text || ZWSP;
    pre.appendChild(code);

    if (host && host.parentNode) {
      host.parentNode.replaceChild(pre, host);
    } else if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(pre);
    } else {
      surface.appendChild(pre);
    }

    placeCaret(code.firstChild, code.firstChild.textContent.length);
    emit();
  }

  /** Apply a block format, or peel it off when the caret is already inside it. */
  function toggleBlock(tag) {
    surface.focus();
    const existing = tag === 'blockquote' || tag === 'pre' ? closestWithin(tag) : null;
    if (!existing) {
      if (tag === 'pre') applyCodeBlock();
      else exec('formatBlock', tag);
      return;
    }
    const first = unwrapBlock(existing);
    placeCaret(first, 0);
    emit();
  }

  /** Insert an empty paragraph after `el` and put the caret in it. */
  function escapeAfter(el) {
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    el.parentNode.insertBefore(p, el.nextSibling);
    placeCaret(p, 0);
    return p;
  }

  surface.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      const key = e.key.toLowerCase();
      const map = { b: 'bold', i: 'italic', u: 'underline' };
      if (map[key] && !e.shiftKey) { e.preventDefault(); exec(map[key]); return; }
      if (key === 'x' && e.shiftKey) { e.preventDefault(); exec('strikeThrough'); return; }
    }

    if (e.key !== 'Enter' || e.shiftKey) return;

    // Enter inside a checklist continues the checklist. Without this the
    // browser clones the <li> without its input and you get a plain bullet,
    // which makes a checkbox list impossible to type.
    const li = closestTaskItem();
    if (!li) {
      handleEnterInQuote(e);
      return;
    }
    e.preventDefault();

    const text = li.textContent.split(ZWSP).join('').trim();
    if (!text) {
      // Enter on an empty item ends the list, the way every list editor does.
      const list = li.parentElement;
      li.remove();
      const p = doc.createElement('p');
      p.appendChild(doc.createElement('br'));
      list.parentNode.insertBefore(p, list.nextSibling);
      if (!list.children.length) list.remove();
      placeCaret(p, 0);
      emit();
      return;
    }

    const next = doc.createElement('li');
    const box = doc.createElement('input');
    box.type = 'checkbox';
    next.appendChild(box);
    next.appendChild(doc.createTextNode(' '));
    li.parentNode.insertBefore(next, li.nextSibling);
    placeCaret(next, next.childNodes.length);
    emit();
  });

  /**
   * Enter on a blank line inside a quote or code block ends it, the way it
   * does in every other editor. Without this the block is a trap: Enter only
   * ever adds another line inside it, and formatBlock cannot undo itself, so
   * there is no way back out to normal text.
   */
  function handleEnterInQuote(e) {
    const block = closestWithin('blockquote, pre');
    if (!block) return;

    if (block.nodeName === 'PRE') {
      // A code block holds plain text, not paragraphs, and browsers disagree
      // wildly about what Enter inserts inside one (a <br>, a <div>, a nested
      // <pre>). Rather than try to read that back, take the key over entirely
      // and insert a real newline — then "blank line" is simply a trailing \n,
      // which is reliable because we are the only thing that writes it.
      e.preventDefault();
      const sel = doc.defaultView.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);

      const upToCaret = doc.createRange();
      upToCaret.selectNodeContents(block);
      upToCaret.setEnd(range.endContainer, range.endOffset);
      const before = upToCaret.toString();

      // Empty line already (or an empty block): this is the second Enter, so
      // leave. Otherwise add the newline and stay.
      if (/(^|\n)[ \t]*$/.test(before)) {
        block.textContent = block.textContent.replace(/\n[ \t]*$/, '');
        escapeAfter(block);
        if (!block.textContent.trim()) block.remove();
      } else {
        range.deleteContents();
        const nl = doc.createTextNode('\n');
        range.insertNode(nl);
        // A trailing newline before the block's end is not rendered unless
        // something follows it, so the caret would appear not to have moved.
        if (!nl.nextSibling) block.appendChild(doc.createTextNode(ZWSP));
        placeCaret(nl.parentNode, Array.from(nl.parentNode.childNodes).indexOf(nl) + 1);
      }
      emit();
      return;
    }

    // The paragraph/div the caret sits in, or the quote itself when its
    // content was never wrapped in one.
    let line = closestWithin('p, div');
    if (line && !block.contains(line)) line = null;
    const text = (line ?? block).textContent.split(ZWSP).join('').trim();
    if (text) return; // still typing in the quote — leave Enter alone

    e.preventDefault();
    if (line && line !== block) line.remove();
    escapeAfter(block);
    if (!block.textContent.trim() && !block.querySelector('img, input')) block.remove();
    emit();
  }

  function placeCaret(node, offset) {
    const range = doc.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Keep the checked attribute in step with the property. innerHTML only
  // serialises attributes, so without this every box converts back to markdown
  // as unchecked no matter what the user ticked.
  surface.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || box.type !== 'checkbox') return;
    if (box.checked) box.setAttribute('checked', '');
    else box.removeAttribute('checked');
    emit();
  });

  /* — surface events — */

  surface.addEventListener('input', emit);
  surface.addEventListener('blur', emit);
  // Paste as plain text: styled HTML from a web page otherwise drags in fonts
  // and colours that turn into noise once converted.
  surface.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    doc.execCommand('insertText', false, text);
    emit();
  });
  source.addEventListener('input', emit);

  /* — mode — */

  function applyModeUi() {
    const isSource = currentMode === 'markdown';
    surface.classList.toggle('mdx-hidden', isSource);
    source.classList.toggle('mdx-hidden', !isSource);
    modeBtn.classList.toggle('active', isSource);
    modeBtn.textContent = isSource ? 'Editor' : 'Markdown';
    // Formatting buttons act on the WYSIWYG surface, which isn't on screen.
    buttons.forEach((b) => { b.disabled = isSource; });
    wrapBtn.disabled = !isSource;
  }

  function setMode(next) {
    if (next === currentMode) return;
    if (next === 'markdown') source.value = md.htmlToMarkdown(surface.innerHTML);
    else setSurfaceHtml(md.markdownToHtml(source.value));
    currentMode = next;
    applyModeUi();
    (currentMode === 'markdown' ? source : surface).focus();
    emit();
  }

  function setValue(markdown) {
    const next = markdown || '';
    if (next === currentMarkdown()) return;
    if (currentMode === 'markdown') source.value = next;
    else setSurfaceHtml(md.markdownToHtml(next));
    refreshPlaceholder();
  }

  setValue(value);
  applyModeUi();
  refreshPlaceholder();

  return {
    getValue: currentMarkdown,
    setValue,
    getMode: () => currentMode,
    setMode,
    focus: () => (currentMode === 'markdown' ? source : surface).focus(),
    destroy: () => root.remove(),
    markdown: md,
  };
}
