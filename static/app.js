const { h, render } = preact;
const { useState, useEffect, useRef, useCallback, useMemo } = preactHooks;
const html = htm.bind(h);

// -- turndown setup --

const turndownService = new TurndownService({
  headingStyle: 'atx', codeBlockStyle: 'fenced',
  bulletListMarker: '-', emDelimiter: '*',
});
turndownService.use(turndownPluginGfm.gfm);

// -- api layer --

const api = {
  async getPlans() {
    const res = await fetch('/api/plans');
    return res.json();
  },
  async getPlan(filename) {
    const res = await fetch('/api/plans/' + encodeURIComponent(filename));
    return res.text();
  },
  async savePlan(filename, content) {
    await fetch('/api/plans/' + encodeURIComponent(filename), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content,
    });
  },
  async deletePlan(filename) {
    await fetch('/api/plans/' + encodeURIComponent(filename), { method: 'DELETE' });
  },
  async deleteBatch(files) {
    await fetch('/api/plans/delete-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
  },
  async renamePlan(filename, newName) {
    const res = await fetch('/api/plans/' + encodeURIComponent(filename) + '/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) return null;
    return res.json();
  },
  async duplicatePlan(filename) {
    const res = await fetch('/api/plans/' + encodeURIComponent(filename) + '/duplicate', { method: 'POST' });
    if (!res.ok) return null;
    return res.json();
  },
  async toggleFavorite(filename) {
    const res = await fetch('/api/favorites/' + encodeURIComponent(filename), { method: 'POST' });
    return res.json();
  },
  async search(q) {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    return res.json();
  },
  async getComments(filename) {
    const res = await fetch('/api/comments/' + encodeURIComponent(filename));
    return res.json();
  },
  async createComment(filename, data) {
    const res = await fetch('/api/comments/' + encodeURIComponent(filename), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },
  async replyComment(filename, threadId, body) {
    const res = await fetch('/api/comments/' + encodeURIComponent(filename) + '/' + threadId + '/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return res.json();
  },
  async resolveComment(filename, threadId) {
    await fetch('/api/comments/' + encodeURIComponent(filename) + '/' + threadId + '/resolve', { method: 'POST' });
  },
  async deleteComment(filename, threadId) {
    await fetch('/api/comments/' + encodeURIComponent(filename) + '/' + threadId, { method: 'DELETE' });
  },
  async getHandoffs() {
    const res = await fetch('/api/handoffs');
    return res.json();
  },
  async getHandoff(filename) {
    const res = await fetch('/api/handoffs/' + encodeURIComponent(filename));
    return res.text();
  },
  async searchHandoffs(q) {
    const res = await fetch('/api/handoffs/search?q=' + encodeURIComponent(q));
    return res.json();
  },
};

// strip `handoff-` prefix, `.md` suffix, and trailing -YYYYMMDD-HHMMSS if present
function handoffDisplayName(filename) {
  let name = filename.replace(/^handoff-/, '').replace(/\.md$/, '');
  name = name.replace(/-\d{8}-\d{6}$/, '');
  return name || filename;
}

function readTabFromHash() {
  const m = (location.hash || '').match(/tab=(\w+)/);
  return m && m[1] === 'handoffs' ? 'handoffs' : 'plans';
}

// -- helpers --

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// -- highlight engine --

function flattenTextNodes(el) {
  // returns { text, nodes: [{ node, start, end }] }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    const start = text.length;
    text += node.textContent;
    nodes.push({ node, start, end: text.length });
  }
  return { text, nodes };
}

function applyCommentHighlights(el, threads) {
  if (!el || !threads.length) return;
  const unresolved = threads.filter(t => !t.resolved);
  if (!unresolved.length) return;

  const { text, nodes } = flattenTextNodes(el);

  // find each thread's position in the flat text
  const anchors = [];
  for (const thread of unresolved) {
    const searchStr = thread.prefix + thread.selectedText + thread.suffix;
    const idx = text.indexOf(searchStr);
    if (idx < 0) continue;
    // offset within searchStr where selectedText begins
    const selStart = idx + thread.prefix.length;
    const selEnd = selStart + thread.selectedText.length;
    anchors.push({ thread, selStart, selEnd });
  }

  // sort descending so DOM mutations don't shift earlier offsets
  anchors.sort((a, b) => b.selStart - a.selStart);

  for (const { thread, selStart, selEnd } of anchors) {
    wrapRange(nodes, selStart, selEnd, thread.id);
  }
}

function wrapRange(nodes, start, end, threadId) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.end <= start || n.start >= end) continue;

    const node = n.node;
    const nodeStart = Math.max(0, start - n.start);
    const nodeEnd = Math.min(node.textContent.length, end - n.start);

    // split if partial match
    let targetNode = node;
    if (nodeEnd < node.textContent.length) {
      targetNode.splitText(nodeEnd);
    }
    if (nodeStart > 0) {
      targetNode = targetNode.splitText(nodeStart);
    }

    const mark = document.createElement('mark');
    mark.className = 'comment-highlight';
    mark.dataset.threadId = threadId;
    targetNode.parentNode.insertBefore(mark, targetNode);
    mark.appendChild(targetNode);
  }
}

function removeCommentHighlights(el) {
  if (!el) return;
  el.querySelectorAll('mark.comment-highlight').forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function getSelectionContext(contentEl) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  // ensure selection is within content
  if (!contentEl.contains(range.commonAncestorContainer)) return null;

  const selectedText = sel.toString().trim();
  if (!selectedText) return null;

  // get flat text for prefix/suffix
  const { text } = flattenTextNodes(contentEl);
  const idx = text.indexOf(selectedText);
  if (idx < 0) return null;

  const prefix = text.slice(Math.max(0, idx - 30), idx);
  const suffix = text.slice(idx + selectedText.length, idx + selectedText.length + 30);

  return { selectedText, prefix, suffix, rect: range.getBoundingClientRect() };
}

// -- components --

function PlanItem({ plan, active, selected, multiselect, onSelect, onLoad, onToggleFavorite }) {
  const name = plan.name.replace(/\.md$/, '');
  const date = new Date(plan.modified * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const cls = 'plan-item' + (active ? ' active' : '') + (selected ? ' selected' : '');
  const starCls = 'star-btn' + (plan.favorited ? ' active' : '');

  return html`
    <div class=${cls} data-file=${plan.name} onClick=${() => multiselect ? onSelect(plan.name) : onLoad(plan.name)}>
      <input type="checkbox" class="checkbox" checked=${selected}
        style=${{ display: multiselect ? 'inline-block' : 'none' }} />
      <div class="plan-info">
        <div class="plan-name" title=${name}>${name}</div>
        <div class="plan-date">${date}</div>
        ${plan.snippet && html`<div class="plan-snippet" dangerouslySetInnerHTML=${{ __html: plan.snippet }}></div>`}
      </div>
      <button class=${starCls} onClick=${e => { e.stopPropagation(); onToggleFavorite(plan.name); }}>
        ${plan.favorited ? '\u2605' : '\u2606'}
      </button>
    </div>
  `;
}

function HandoffItem({ item, active, onLoad }) {
  const display = handoffDisplayName(item.name);
  const date = new Date(item.modified * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const cls = 'plan-item' + (active ? ' active' : '');
  return html`
    <div class=${cls} onClick=${() => onLoad(item.name)}>
      <div class="plan-info">
        <div class="plan-name" title=${item.name}>${display}</div>
        <div class="plan-date">${date}</div>
        ${item.snippet && html`<div class="plan-snippet" dangerouslySetInnerHTML=${{ __html: item.snippet }}></div>`}
      </div>
    </div>
  `;
}

function Sidebar({ plans, handoffs, tab, activeFile, multiselect, selected, searchResults,
  onLoad, onLoadHandoff, onSelect, onToggleFavorite, onEnterMultiselect, onExitMultiselect,
  onDeleteBatch, onSearch, onTabChange, onRefresh }) {
  const [query, setQuery] = useState('');
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);
  const lastClickedIndex = useRef(null);

  const source = tab === 'handoffs' ? handoffs : plans;
  const filtered = useMemo(() => {
    if (searchResults !== null) return searchResults;
    const lf = query.toLowerCase();
    return source.filter(p => p.name.toLowerCase().includes(lf));
  }, [source, query, searchResults]);

  const count = searchResults !== null ? filtered.length + ' results' : source.length;

  const handleSearch = useCallback((e) => {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(searchTimer.current);
    if (!q) {
      onSearch(null);
      return;
    }
    searchTimer.current = setTimeout(() => {
      const seq = ++searchSeq.current;
      const fn = tab === 'handoffs' ? api.searchHandoffs : api.search;
      fn(q).then(data => {
        if (seq === searchSeq.current) onSearch(data);
      });
    }, 200);
  }, [onSearch, tab]);

  // clear search on tab switch
  useEffect(() => {
    setQuery('');
    onSearch(null);
    clearTimeout(searchTimer.current);
  }, [tab]);

  const handleSearchKey = useCallback((e) => {
    if (e.key === 'Escape') {
      setQuery('');
      onSearch(null);
    }
  }, [onSearch]);

  const handleItemClick = useCallback((e) => {
    const item = e.target.closest('.plan-item');
    if (!item) return;
    if (e.target.closest('.star-btn')) return;
    const file = item.dataset.file;
    const items = [...item.parentNode.querySelectorAll('.plan-item')];
    const clickedIdx = items.indexOf(item);

    if (e.shiftKey && lastClickedIndex.current !== null) {
      if (!multiselect) onEnterMultiselect();
      const lo = Math.min(lastClickedIndex.current, clickedIdx);
      const hi = Math.max(lastClickedIndex.current, clickedIdx);
      for (let i = lo; i <= hi; i++) {
        onSelect(items[i].dataset.file, true);
      }
      return;
    }
    lastClickedIndex.current = clickedIdx;
  }, [multiselect, onEnterMultiselect, onSelect]);

  const isHandoffs = tab === 'handoffs';
  return html`
    <div id="sidebar" class=${multiselect ? 'multiselect-mode' : ''}>
      <div id="sidebar-header">
        <div id="tab-strip">
          <button class=${'tab' + (!isHandoffs ? ' active' : '')} onClick=${() => onTabChange('plans')}>Plans</button>
          <button class=${'tab' + (isHandoffs ? ' active' : '')} onClick=${() => onTabChange('handoffs')}>Handoffs</button>
        </div>
        <span id="count">${count}</span>
        <button class="refresh-btn" title="Refresh" onClick=${onRefresh}>↻</button>
      </div>
      <input id="search" type="text"
        placeholder=${isHandoffs ? 'search handoffs...' : 'search plans...'}
        value=${query} onInput=${handleSearch} onKeyDown=${handleSearchKey} />
      ${!isHandoffs && multiselect && html`
        <div id="toolbar" class="visible">
          <span id="sel-count">${selected.size} selected</span>
          <button onClick=${onDeleteBatch}>delete</button>
          <button class="cancel-btn" onClick=${onExitMultiselect}>cancel</button>
        </div>
      `}
      <div id="plan-list" onClick=${isHandoffs ? undefined : handleItemClick}>
        ${isHandoffs
          ? (filtered.length === 0
              ? html`<div class="empty-list">no handoffs in $TMPDIR</div>`
              : filtered.map(p => html`
                  <${HandoffItem} key=${p.name} item=${p}
                    active=${p.name === activeFile} onLoad=${onLoadHandoff} />
                `))
          : filtered.map(p => html`
              <${PlanItem} key=${p.name} plan=${p} active=${p.name === activeFile}
                selected=${selected.has(p.name)} multiselect=${multiselect}
                onSelect=${onSelect} onLoad=${onLoad} onToggleFavorite=${onToggleFavorite} />
            `)}
      </div>
    </div>
  `;
}

function EditToolbar({ onCmd }) {
  return html`
    <div id="edit-toolbar" class="visible">
      <button onClick=${() => onCmd('bold')} title="Bold (Ctrl+B)"><b>B</b></button>
      <button onClick=${() => onCmd('italic')} title="Italic (Ctrl+I)"><i>I</i></button>
      <button onClick=${() => onCmd('code')} title="Inline code">{ }</button>
      <span class="sep"></span>
      <button onClick=${() => onCmd('h1')} title="Heading 1">H1</button>
      <button onClick=${() => onCmd('h2')} title="Heading 2">H2</button>
      <button onClick=${() => onCmd('h3')} title="Heading 3">H3</button>
      <span class="sep"></span>
      <button onClick=${() => onCmd('ul')} title="Bullet list">\u2022 list</button>
      <button onClick=${() => onCmd('ol')} title="Numbered list">1. list</button>
      <span class="sep"></span>
      <button onClick=${() => onCmd('link')} title="Insert link">link</button>
    </div>
  `;
}

function CommentToolbar({ pos, onComment }) {
  if (!pos) return null;
  const style = { display: 'block', left: pos.x + 'px', top: pos.y + 'px' };
  return html`
    <div class="comment-toolbar visible" style=${style}>
      <button onClick=${onComment}>\u{1F4AC} comment</button>
    </div>
  `;
}

function CommentInputPopover({ pos, onSubmit, onCancel }) {
  const [body, setBody] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.focus();
  }, []);

  const handleSubmit = () => {
    if (!body.trim()) return;
    onSubmit(body.trim());
    setBody('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
    if (e.key === 'Escape') onCancel();
  };

  if (!pos) return null;
  const style = { display: 'block', left: pos.x + 'px', top: pos.y + 'px' };

  return html`
    <div class="comment-popover visible" style=${style}>
      <textarea ref=${ref} rows="3" placeholder="add a comment..."
        value=${body} onInput=${e => setBody(e.target.value)} onKeyDown=${handleKey}></textarea>
      <div class="comment-popover-actions">
        <button class="header-btn" onClick=${onCancel}>cancel</button>
        <button class="header-btn primary" onClick=${handleSubmit}>comment</button>
      </div>
    </div>
  `;
}

function CommentThreadPopover({ thread, pos, onReply, onResolve, onDelete, onClose }) {
  const [replyBody, setReplyBody] = useState('');
  const ref = useRef(null);

  if (!thread || !pos) return null;

  const handleReply = () => {
    if (!replyBody.trim()) return;
    onReply(thread.id, replyBody.trim());
    setReplyBody('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleReply();
    if (e.key === 'Escape') onClose();
  };

  const style = { display: 'block', left: pos.x + 'px', top: pos.y + 'px' };

  return html`
    <div class="comment-popover visible" style=${style}>
      <div class="comment-quoted-text">${thread.selectedText}</div>
      ${thread.comments.map(c => html`
        <div class="comment-entry" key=${c.id}>
          <div>${c.body}</div>
          <div class="comment-time">${timeAgo(c.createdAt)}</div>
        </div>
      `)}
      <textarea rows="2" placeholder="reply..." value=${replyBody}
        onInput=${e => setReplyBody(e.target.value)} onKeyDown=${handleKey}></textarea>
      <div class="comment-popover-actions">
        <button class="header-btn" onClick=${handleReply}>reply</button>
        <button class="header-btn" onClick=${() => onResolve(thread.id)}>resolve</button>
        <button class="header-btn danger" onClick=${() => onDelete(thread.id)}>delete</button>
      </div>
    </div>
  `;
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  if (!message) return null;
  return html`
    <div class="dialog-overlay visible">
      <div class="dialog">
        <p>${message}</p>
        <div class="dialog-buttons">
          <button class="header-btn" onClick=${onCancel}>cancel</button>
          <button class="header-btn danger" onClick=${onConfirm}>delete</button>
        </div>
      </div>
    </div>
  `;
}

function ContentPane({ activeFile, activeContent, editing, commentThreads, isHandoff, handoffPath,
  onSave, onEnterEdit, onExitEdit, onDelete, onDuplicate, onRename, onCopyPath,
  onToggleFavorite, onEnterMultiselect, plans,
  onCreateComment, onReplyComment, onResolveComment, onDeleteComment }) {

  const contentRef = useRef(null);
  const [commentToolbarPos, setCommentToolbarPos] = useState(null);
  const [commentInputPos, setCommentInputPos] = useState(null);
  const [pendingSelection, setPendingSelection] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  const [threadPopoverPos, setThreadPopoverPos] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [renamingValue, setRenamingValue] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);

  const plan = plans.find(p => p.name === activeFile);
  const isFav = plan?.favorited;
  const unresolvedCount = commentThreads.filter(t => !t.resolved).length;

  // render markdown + highlights when content or comments change
  useEffect(() => {
    if (!contentRef.current || !activeContent || editing) return;
    contentRef.current.innerHTML = marked.parse(activeContent);
    applyCommentHighlights(contentRef.current, commentThreads);
  }, [activeContent, commentThreads, editing]);

  // handle text selection for comment toolbar
  const handleMouseUp = useCallback(() => {
    if (editing) return;
    // small delay so selection is finalized
    setTimeout(() => {
      const ctx = getSelectionContext(contentRef.current);
      if (!ctx) {
        setCommentToolbarPos(null);
        return;
      }
      setCommentToolbarPos({
        x: ctx.rect.left + ctx.rect.width / 2 - 50,
        y: ctx.rect.top - 40,
      });
      setPendingSelection(ctx);
    }, 10);
  }, [editing]);

  // handle click on comment highlight
  const handleContentClick = useCallback((e) => {
    if (editing) return;
    const mark = e.target.closest('mark.comment-highlight');
    if (mark) {
      const threadId = mark.dataset.threadId;
      const thread = commentThreads.find(t => t.id === threadId);
      if (thread) {
        const rect = mark.getBoundingClientRect();
        setActiveThread(thread);
        setThreadPopoverPos({
          x: Math.min(rect.left, window.innerWidth - 340),
          y: rect.bottom + 8,
        });
        setCommentToolbarPos(null);
      }
    }
  }, [editing, commentThreads]);

  // dismiss popovers on outside click
  useEffect(() => {
    const handler = (e) => {
      if (e.target.closest('.comment-toolbar') || e.target.closest('.comment-popover')) return;
      setCommentToolbarPos(null);
      setCommentInputPos(null);
      setPendingSelection(null);
      setActiveThread(null);
      setThreadPopoverPos(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // escape to dismiss popovers
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        setCommentToolbarPos(null);
        setCommentInputPos(null);
        setPendingSelection(null);
        setActiveThread(null);
        setThreadPopoverPos(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleStartComment = useCallback(() => {
    if (!pendingSelection) return;
    setCommentInputPos({
      x: Math.min(pendingSelection.rect.left, window.innerWidth - 340),
      y: pendingSelection.rect.bottom + 8,
    });
    setCommentToolbarPos(null);
    window.getSelection().removeAllRanges();
  }, [pendingSelection]);

  const handleSubmitComment = useCallback(async (body) => {
    if (!pendingSelection || !activeFile) return;
    await onCreateComment(activeFile, {
      selectedText: pendingSelection.selectedText,
      prefix: pendingSelection.prefix,
      suffix: pendingSelection.suffix,
      body,
    });
    setCommentInputPos(null);
    setPendingSelection(null);
  }, [pendingSelection, activeFile, onCreateComment]);

  const handleReply = useCallback(async (threadId, body) => {
    const comment = await onReplyComment(activeFile, threadId, body);
    // update active thread with new reply inline
    setActiveThread(prev => {
      if (!prev || prev.id !== threadId) return prev;
      return { ...prev, comments: [...prev.comments, comment] };
    });
  }, [activeFile, onReplyComment]);

  const handleResolve = useCallback(async (threadId) => {
    await onResolveComment(activeFile, threadId);
    setActiveThread(null);
    setThreadPopoverPos(null);
  }, [activeFile, onResolveComment]);

  const handleDeleteThread = useCallback(async (threadId) => {
    await onDeleteComment(activeFile, threadId);
    setActiveThread(null);
    setThreadPopoverPos(null);
  }, [activeFile, onDeleteComment]);

  // edit mode
  const handleEnterEdit = useCallback(() => {
    removeCommentHighlights(contentRef.current);
    const scrollY = contentRef.current.scrollTop;
    contentRef.current.contentEditable = 'true';
    contentRef.current.classList.add('editing');
    // lock code blocks
    contentRef.current.querySelectorAll('pre').forEach(el => {
      el.contentEditable = 'false';
      el.classList.add('locked-block');
    });
    contentRef.current.focus();
    contentRef.current.scrollTop = scrollY;
    onEnterEdit();
  }, [onEnterEdit]);

  const handleSave = useCallback(async () => {
    const html = contentRef.current.innerHTML;
    const md = turndownService.turndown(html);
    contentRef.current.contentEditable = 'false';
    contentRef.current.classList.remove('editing');
    await onSave(activeFile, md);
  }, [activeFile, onSave]);

  const handleCancelEdit = useCallback(() => {
    contentRef.current.contentEditable = 'false';
    contentRef.current.classList.remove('editing');
    contentRef.current.innerHTML = marked.parse(activeContent);
    applyCommentHighlights(contentRef.current, commentThreads);
    onExitEdit();
  }, [activeContent, commentThreads, onExitEdit]);

  const handleCmd = useCallback((cmd) => {
    if (cmd === 'bold') document.execCommand('bold');
    else if (cmd === 'italic') document.execCommand('italic');
    else if (cmd === 'code') {
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const code = document.createElement('code');
        range.surroundContents(code);
      }
    }
    else if (cmd === 'h1') document.execCommand('formatBlock', false, 'h1');
    else if (cmd === 'h2') document.execCommand('formatBlock', false, 'h2');
    else if (cmd === 'h3') document.execCommand('formatBlock', false, 'h3');
    else if (cmd === 'ul') document.execCommand('insertUnorderedList');
    else if (cmd === 'ol') document.execCommand('insertOrderedList');
    else if (cmd === 'link') {
      const url = prompt('URL:');
      if (url) document.execCommand('createLink', false, url);
    }
    contentRef.current.focus();
  }, []);

  // paste as plain text in edit mode
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handler = (e) => {
      if (!editing) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    };
    el.addEventListener('paste', handler);
    return () => el.removeEventListener('paste', handler);
  }, [editing]);

  // ctrl+s to save
  useEffect(() => {
    const handler = (e) => {
      if (editing && (e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editing, handleSave]);

  // rename
  const handleStartRename = useCallback(() => {
    setRenaming(true);
    setRenamingValue(activeFile.replace(/\.md$/, ''));
  }, [activeFile]);

  const handleFinishRename = useCallback(async () => {
    const newName = renamingValue.trim();
    const current = activeFile.replace(/\.md$/, '');
    setRenaming(false);
    if (newName && newName !== current) {
      await onRename(activeFile, newName);
    }
  }, [renamingValue, activeFile, onRename]);

  const handleCopyPath = useCallback(() => {
    const p = isHandoff ? (handoffPath || activeFile) : ('~/.claude/plans/' + activeFile);
    navigator.clipboard.writeText(p);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 1500);
  }, [activeFile, isHandoff, handoffPath]);

  if (!activeFile) {
    return html`
      <div id="content-wrap">
        <div id="content-header"></div>
        <div id="content" class="empty">select a plan</div>
      </div>
    `;
  }

  return html`
    <div id="content-wrap">
      <div id="content-header" class="visible">
        ${renaming ? html`
          <input id="rename-input" value=${renamingValue}
            onInput=${e => setRenamingValue(e.target.value)}
            onKeyDown=${e => { if (e.key === 'Enter') handleFinishRename(); if (e.key === 'Escape') setRenaming(false); }}
            onBlur=${handleFinishRename}
            ref=${el => { if (el && !el.dataset.inited) { el.dataset.inited = '1'; setTimeout(() => { el.focus(); el.select(); }, 0); }}} />
        ` : html`
          <span id="content-title">${isHandoff ? handoffDisplayName(activeFile) : activeFile.replace(/\.md$/, '')}</span>
        `}
        ${isHandoff ? html`
          <button class="header-btn" onClick=${handleCopyPath}>${copyFeedback ? 'copied!' : 'copy path'}</button>
        ` : html`
          <button class=${'star-btn' + (isFav ? ' active' : '')} style="font-size:18px" title="Toggle favorite"
            onClick=${() => onToggleFavorite(activeFile)}>${isFav ? '\u2605' : '\u2606'}</button>
          ${unresolvedCount > 0 && html`
            <span class="comment-badge visible" onClick=${() => {
              const first = contentRef.current?.querySelector('.comment-highlight');
              if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}>${unresolvedCount} comment${unresolvedCount > 1 ? 's' : ''}</span>
          `}
          ${!editing ? html`
            <button class="header-btn" onClick=${() => onDuplicate(activeFile)}>duplicate</button>
            <button class="header-btn" onClick=${handleStartRename}>rename</button>
            <button class="header-btn" onClick=${handleCopyPath}>${copyFeedback ? 'copied!' : 'copy path'}</button>
            <button class="header-btn" onClick=${handleEnterEdit}>edit</button>
            <button class="header-btn" onClick=${onEnterMultiselect}>select</button>
            <button class="header-btn danger" onClick=${() => onDelete(activeFile)}>delete</button>
          ` : html`
            <button class="header-btn primary" onClick=${handleSave}>save</button>
            <button class="header-btn" onClick=${handleCancelEdit}>cancel</button>
          `}
        `}
      </div>
      ${editing && html`<${EditToolbar} onCmd=${handleCmd} />`}
      <div id="content" ref=${contentRef}
        onMouseUp=${handleMouseUp} onClick=${handleContentClick}></div>
      <${CommentToolbar} pos=${commentToolbarPos} onComment=${handleStartComment} />
      <${CommentInputPopover} pos=${commentInputPos}
        onSubmit=${handleSubmitComment}
        onCancel=${() => { setCommentInputPos(null); setPendingSelection(null); }} />
      <${CommentThreadPopover} thread=${activeThread} pos=${threadPopoverPos}
        onReply=${handleReply} onResolve=${handleResolve}
        onDelete=${handleDeleteThread}
        onClose=${() => { setActiveThread(null); setThreadPopoverPos(null); }} />
    </div>
  `;
}

// -- app --

function App() {
  const [plans, setPlans] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [tab, setTab] = useState(readTabFromHash());
  const [activeFile, setActiveFile] = useState(null);
  const [activeKind, setActiveKind] = useState('plan'); // 'plan' | 'handoff'
  const [activeContent, setActiveContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [multiselect, setMultiselect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [searchResults, setSearchResults] = useState(null);
  const [commentThreads, setCommentThreads] = useState([]);
  const [confirmMsg, setConfirmMsg] = useState(null);
  const confirmResolve = useRef(null);

  const isHandoff = activeKind === 'handoff';
  const handoffPath = useMemo(() => {
    if (!isHandoff || !activeFile) return null;
    const found = handoffs.find(h => h.name === activeFile);
    return found?.path || null;
  }, [isHandoff, activeFile, handoffs]);

  const confirm = useCallback((msg) => {
    return new Promise(resolve => {
      setConfirmMsg(msg);
      confirmResolve.current = resolve;
    });
  }, []);

  const loadPlans = useCallback(async () => {
    const data = await api.getPlans();
    setPlans(data);
  }, []);

  const loadHandoffs = useCallback(async () => {
    const data = await api.getHandoffs();
    setHandoffs(data);
  }, []);

  const loadPlan = useCallback(async (filename) => {
    setEditing(false);
    setActiveFile(filename);
    setActiveKind('plan');
    const content = await api.getPlan(filename);
    setActiveContent(content);
    const threads = await api.getComments(filename);
    setCommentThreads(threads);
  }, []);

  const loadHandoff = useCallback(async (filename) => {
    setEditing(false);
    setActiveFile(filename);
    setActiveKind('handoff');
    setCommentThreads([]);
    const content = await api.getHandoff(filename);
    setActiveContent(content);
  }, []);

  const handleTabChange = useCallback((next) => {
    setTab(next);
    location.hash = 'tab=' + next;
    setSearchResults(null);
  }, []);

  const handleRefresh = useCallback(() => {
    if (tab === 'handoffs') loadHandoffs();
    else loadPlans();
  }, [tab, loadHandoffs, loadPlans]);

  // refresh active tab on window focus
  useEffect(() => {
    const onFocus = () => handleRefresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [handleRefresh]);

  // respond to hash changes (back/forward)
  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // load list for active tab when it changes
  useEffect(() => {
    if (tab === 'handoffs') loadHandoffs();
    else loadPlans();
  }, [tab, loadHandoffs, loadPlans]);

  const handleToggleFavorite = useCallback(async (filename) => {
    const data = await api.toggleFavorite(filename);
    setPlans(prev => {
      const next = prev.map(p => p.name === filename ? { ...p, favorited: data.favorited } : p);
      next.sort((a, b) => (a.favorited === b.favorited) ? b.modified - a.modified : a.favorited ? -1 : 1);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (filename) => {
    const ok = await confirm('Delete "' + filename.replace(/\.md$/, '') + '"?');
    if (!ok) return;
    await api.deletePlan(filename);
    if (activeFile === filename) {
      setActiveFile(null);
      setActiveContent('');
      setCommentThreads([]);
    }
    await loadPlans();
  }, [activeFile, confirm, loadPlans]);

  const handleDeleteBatch = useCallback(async () => {
    if (selected.size === 0) return;
    const ok = await confirm('Delete ' + selected.size + ' plan(s)?');
    if (!ok) return;
    await api.deleteBatch(Array.from(selected));
    if (selected.has(activeFile)) {
      setActiveFile(null);
      setActiveContent('');
      setCommentThreads([]);
    }
    setMultiselect(false);
    setSelected(new Set());
    await loadPlans();
  }, [selected, activeFile, confirm, loadPlans]);

  const handleSave = useCallback(async (filename, content) => {
    await api.savePlan(filename, content);
    setActiveContent(content);
    setEditing(false);
    // reload comments to reapply highlights
    const threads = await api.getComments(filename);
    setCommentThreads(threads);
    await loadPlans();
  }, [loadPlans]);

  const handleRename = useCallback(async (filename, newName) => {
    const data = await api.renamePlan(filename, newName);
    if (data) {
      if (activeFile === filename) setActiveFile(data.name);
      await loadPlans();
      if (data.name) loadPlan(data.name);
    }
  }, [activeFile, loadPlans, loadPlan]);

  const handleDuplicate = useCallback(async (filename) => {
    const data = await api.duplicatePlan(filename);
    if (data) {
      await loadPlans();
      loadPlan(data.name);
    }
  }, [loadPlans, loadPlan]);

  const handleSelect = useCallback((name, forceAdd) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (forceAdd) next.add(name);
      else if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleCopyPath = useCallback(() => {
    if (!activeFile) return;
    navigator.clipboard.writeText('~/.claude/plans/' + activeFile);
  }, [activeFile]);

  // comment handlers
  const handleCreateComment = useCallback(async (filename, data) => {
    const thread = await api.createComment(filename, data);
    setCommentThreads(prev => [...prev, thread]);
  }, []);

  const handleReplyComment = useCallback(async (filename, threadId, body) => {
    const comment = await api.replyComment(filename, threadId, body);
    setCommentThreads(prev => prev.map(t =>
      t.id === threadId ? { ...t, comments: [...t.comments, comment] } : t
    ));
    return comment;
  }, []);

  const handleResolveComment = useCallback(async (filename, threadId) => {
    await api.resolveComment(filename, threadId);
    setCommentThreads(prev => prev.map(t =>
      t.id === threadId ? { ...t, resolved: true } : t
    ));
  }, []);

  const handleDeleteComment = useCallback(async (filename, threadId) => {
    await api.deleteComment(filename, threadId);
    setCommentThreads(prev => prev.filter(t => t.id !== threadId));
  }, []);

  return html`
    <${Sidebar}
      plans=${plans} handoffs=${handoffs} tab=${tab}
      activeFile=${activeFile}
      multiselect=${multiselect} selected=${selected}
      searchResults=${searchResults}
      onLoad=${loadPlan} onLoadHandoff=${loadHandoff} onSelect=${handleSelect}
      onToggleFavorite=${handleToggleFavorite}
      onEnterMultiselect=${() => { setMultiselect(true); setSelected(new Set()); }}
      onExitMultiselect=${() => { setMultiselect(false); setSelected(new Set()); }}
      onDeleteBatch=${handleDeleteBatch}
      onSearch=${setSearchResults}
      onTabChange=${handleTabChange}
      onRefresh=${handleRefresh} />
    <${ContentPane}
      activeFile=${activeFile} activeContent=${activeContent}
      editing=${editing} commentThreads=${commentThreads} plans=${plans}
      isHandoff=${isHandoff} handoffPath=${handoffPath}
      onSave=${handleSave} onEnterEdit=${() => setEditing(true)} onExitEdit=${() => setEditing(false)}
      onDelete=${handleDelete} onDuplicate=${handleDuplicate}
      onRename=${handleRename} onCopyPath=${handleCopyPath}
      onToggleFavorite=${handleToggleFavorite}
      onEnterMultiselect=${() => { setMultiselect(true); setSelected(new Set()); }}
      onCreateComment=${handleCreateComment}
      onReplyComment=${handleReplyComment}
      onResolveComment=${handleResolveComment}
      onDeleteComment=${handleDeleteComment} />
    <${ConfirmDialog} message=${confirmMsg}
      onConfirm=${() => { setConfirmMsg(null); confirmResolve.current?.(true); }}
      onCancel=${() => { setConfirmMsg(null); confirmResolve.current?.(false); }} />
  `;
}

// -- mount --

render(html`<${App} />`, document.getElementById('app'));

// pwa
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}
