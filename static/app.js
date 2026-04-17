let plans = [];
let activeFile = null;
let activeContent = '';  // raw markdown of active plan
let editing = false;
let multiselect = false;
const selected = new Set();
let confirmResolve = null;
let searchResults = null;
let searchSeq = 0;
let searchTimer = null;
let lastClickedIndex = null;

// -- data --

async function loadPlans() {
  const res = await fetch('/api/plans');
  plans = await res.json();
  document.getElementById('count').textContent = plans.length;
  renderList(document.getElementById('search').value);
}

async function loadPlan(filename) {
  exitEdit();
  activeFile = filename;
  renderList(document.getElementById('search').value);
  const header = document.getElementById('content-header');
  header.className = 'visible';
  document.getElementById('content-title').textContent = filename.replace(/\.md$/, '');
  const content = document.getElementById('content');
  content.className = '';
  const res = await fetch('/api/plans/' + encodeURIComponent(filename));
  activeContent = await res.text();
  content.innerHTML = marked.parse(activeContent);
  updateStarButton();
}

async function deletePlan(filename) {
  await fetch('/api/plans/' + encodeURIComponent(filename), { method: 'DELETE' });
  if (activeFile === filename) {
    activeFile = null;
    activeContent = '';
    document.getElementById('content').className = 'empty';
    document.getElementById('content').innerHTML = 'select a plan';
    document.getElementById('content-header').className = '';
  }
  await loadPlans();
}

async function deleteBatch(files) {
  await fetch('/api/plans/delete-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: Array.from(files) }),
  });
  if (files.has(activeFile)) {
    activeFile = null;
    activeContent = '';
    document.getElementById('content').className = 'empty';
    document.getElementById('content').innerHTML = 'select a plan';
    document.getElementById('content-header').className = '';
  }
  exitMultiselect();
  await loadPlans();
}

async function renamePlan(oldName, newName) {
  const res = await fetch('/api/plans/' + encodeURIComponent(oldName) + '/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  if (activeFile === oldName) activeFile = data.name;
  await loadPlans();
  if (activeFile) loadPlan(activeFile);
  return true;
}

async function savePlan(filename, content) {
  await fetch('/api/plans/' + encodeURIComponent(filename), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: content,
  });
  activeContent = content;
  await loadPlans();
}

async function duplicatePlan(filename) {
  const res = await fetch('/api/plans/' + encodeURIComponent(filename) + '/duplicate', { method: 'POST' });
  if (!res.ok) return;
  const data = await res.json();
  await loadPlans();
  loadPlan(data.name);
}

async function toggleFavorite(filename) {
  const res = await fetch('/api/favorites/' + encodeURIComponent(filename), { method: 'POST' });
  const data = await res.json();
  // update local state
  const plan = plans.find(p => p.name === filename);
  if (plan) plan.favorited = data.favorited;
  // re-sort: favorites first, then by modified desc
  plans.sort((a, b) => (a.favorited === b.favorited) ? b.modified - a.modified : a.favorited ? -1 : 1);
  renderList(document.getElementById('search').value);
  updateStarButton();
}

function updateStarButton() {
  const btn = document.getElementById('btn-star');
  if (!activeFile) return;
  const plan = plans.find(p => p.name === activeFile);
  const fav = plan?.favorited;
  btn.innerHTML = fav ? '&#9733;' : '&#9734;';
  btn.classList.toggle('active', !!fav);
}

// -- rendering --

function renderList(filter) {
  const list = document.getElementById('plan-list');
  const countEl = document.getElementById('count');
  let filtered;
  if (searchResults !== null) {
    filtered = searchResults;
    countEl.textContent = filtered.length + ' results';
  } else {
    const lf = filter.toLowerCase();
    filtered = plans.filter(p => p.name.toLowerCase().includes(lf));
    countEl.textContent = plans.length;
  }
  list.innerHTML = filtered.map(p => {
    const name = p.name.replace(/\.md$/, '');
    const date = new Date(p.modified * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const active = p.name === activeFile ? ' active' : '';
    const sel = selected.has(p.name) ? ' selected' : '';
    const checked = selected.has(p.name) ? 'checked' : '';
    const starCls = p.favorited ? ' active' : '';
    const snippetHtml = p.snippet ? `<div class="plan-snippet">${p.snippet}</div>` : '';
    return `<div class="plan-item${active}${sel}" data-file="${esc(p.name)}">
      <input type="checkbox" class="checkbox" ${checked}>
      <div class="plan-info">
        <div class="plan-name" title="${esc(name)}">${esc(name)}</div>
        <div class="plan-date">${date}</div>
        ${snippetHtml}
      </div>
      <button class="star-btn${starCls}" data-star="${esc(p.name)}">${p.favorited ? '&#9733;' : '&#9734;'}</button>
    </div>`;
  }).join('');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// -- turndown setup --

const turndownService = new TurndownService({
  headingStyle: 'atx', codeBlockStyle: 'fenced',
  bulletListMarker: '-', emDelimiter: '*',
});
turndownService.use(turndownPluginGfm.gfm);

// -- edit mode --

function enterEdit() {
  editing = true;
  const content = document.getElementById('content');
  const scrollY = content.scrollTop;
  content.contentEditable = 'true';
  content.classList.add('editing');
  // lock code blocks — contenteditable mangles their structure
  content.querySelectorAll('pre').forEach(el => {
    el.contentEditable = 'false';
    el.classList.add('locked-block');
  });
  document.getElementById('edit-toolbar').classList.add('visible');
  document.getElementById('btn-edit').style.display = 'none';
  document.getElementById('btn-duplicate').style.display = 'none';
  document.getElementById('btn-rename').style.display = 'none';
  document.getElementById('btn-copy-path').style.display = 'none';
  document.getElementById('btn-delete').style.display = 'none';
  document.getElementById('btn-select').style.display = 'none';
  document.getElementById('btn-star').style.display = 'none';
  document.getElementById('btn-save').style.display = '';
  document.getElementById('btn-cancel-edit').style.display = '';
  content.focus();
  content.scrollTop = scrollY;
}

function exitEdit() {
  editing = false;
  const content = document.getElementById('content');
  content.contentEditable = 'false';
  content.classList.remove('editing');
  document.getElementById('edit-toolbar').classList.remove('visible');
  document.getElementById('btn-edit').style.display = '';
  document.getElementById('btn-duplicate').style.display = '';
  document.getElementById('btn-rename').style.display = '';
  document.getElementById('btn-copy-path').style.display = '';
  document.getElementById('btn-delete').style.display = '';
  document.getElementById('btn-select').style.display = '';
  document.getElementById('btn-star').style.display = '';
  document.getElementById('btn-save').style.display = 'none';
  document.getElementById('btn-cancel-edit').style.display = 'none';
}

// -- multiselect --

function enterMultiselect() {
  multiselect = true;
  selected.clear();
  document.getElementById('sidebar').classList.add('multiselect-mode');
  document.getElementById('toolbar').classList.add('visible');
  updateSelCount();
  renderList(document.getElementById('search').value);
}

function exitMultiselect() {
  multiselect = false;
  selected.clear();
  document.getElementById('sidebar').classList.remove('multiselect-mode');
  document.getElementById('toolbar').classList.remove('visible');
  renderList(document.getElementById('search').value);
}

function toggleSelection(name) {
  if (selected.has(name)) selected.delete(name); else selected.add(name);
  updateSelCount();
  renderList(document.getElementById('search').value);
}

function updateSelCount() {
  document.getElementById('sel-count').textContent = selected.size + ' selected';
}

// -- confirm dialog --

function confirm(msg) {
  return new Promise(resolve => {
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-dialog').classList.add('visible');
    confirmResolve = resolve;
  });
}

document.getElementById('confirm-yes').onclick = () => {
  document.getElementById('confirm-dialog').classList.remove('visible');
  if (confirmResolve) confirmResolve(true);
};
document.getElementById('confirm-no').onclick = () => {
  document.getElementById('confirm-dialog').classList.remove('visible');
  if (confirmResolve) confirmResolve(false);
};

// -- events --

document.getElementById('plan-list').addEventListener('click', e => {
  // star click
  const starBtn = e.target.closest('.star-btn');
  if (starBtn) {
    e.stopPropagation();
    toggleFavorite(starBtn.dataset.star);
    return;
  }
  const item = e.target.closest('.plan-item');
  if (!item) return;
  const file = item.dataset.file;
  const items = [...document.querySelectorAll('#plan-list .plan-item')];
  const clickedIdx = items.indexOf(item);

  if (e.shiftKey && lastClickedIndex !== null) {
    // shift-click range select
    if (!multiselect) enterMultiselect();
    const lo = Math.min(lastClickedIndex, clickedIdx);
    const hi = Math.max(lastClickedIndex, clickedIdx);
    for (let i = lo; i <= hi; i++) {
      selected.add(items[i].dataset.file);
    }
    updateSelCount();
    renderList(document.getElementById('search').value);
    return;
  }

  lastClickedIndex = clickedIdx;
  if (multiselect) {
    toggleSelection(file);
  } else {
    loadPlan(file);
  }
});

document.getElementById('btn-star').onclick = () => {
  if (activeFile) toggleFavorite(activeFile);
};

document.getElementById('search').addEventListener('input', e => {
  const q = e.target.value;
  clearTimeout(searchTimer);
  if (!q) {
    searchResults = null;
    renderList('');
    return;
  }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (seq !== searchSeq) return; // discard stale
    searchResults = data;
    renderList(q);
  }, 200);
});
document.getElementById('search').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.target.value = '';
    searchResults = null;
    clearTimeout(searchTimer);
    renderList('');
  }
});

// header buttons
document.getElementById('btn-edit').onclick = () => { if (activeFile) enterEdit(); };
document.getElementById('btn-save').onclick = async () => {
  if (!activeFile) return;
  const html = document.getElementById('content').innerHTML;
  const md = turndownService.turndown(html);
  await savePlan(activeFile, md);
  exitEdit();
  // re-render from saved markdown for consistency
  document.getElementById('content').innerHTML = marked.parse(activeContent);
};
document.getElementById('btn-cancel-edit').onclick = () => {
  exitEdit();
  if (activeContent) {
    document.getElementById('content').innerHTML = marked.parse(activeContent);
  }
};

document.getElementById('btn-delete').onclick = async () => {
  if (!activeFile) return;
  const ok = await confirm('Delete "' + activeFile.replace(/\.md$/, '') + '"?');
  if (ok) deletePlan(activeFile);
};

document.getElementById('btn-select').onclick = () => enterMultiselect();
document.getElementById('cancel-select').onclick = () => exitMultiselect();
document.getElementById('del-selected').onclick = async () => {
  if (selected.size === 0) return;
  const ok = await confirm('Delete ' + selected.size + ' plan(s)?');
  if (ok) deleteBatch(selected);
};

document.getElementById('btn-duplicate').onclick = () => {
  if (activeFile) duplicatePlan(activeFile);
};

document.getElementById('btn-copy-path').onclick = () => {
  if (!activeFile) return;
  const path = '~/.claude/plans/' + activeFile;
  navigator.clipboard.writeText(path);
  const btn = document.getElementById('btn-copy-path');
  btn.textContent = 'copied!';
  setTimeout(() => { btn.textContent = 'copy path'; }, 1500);
};

document.getElementById('btn-rename').onclick = () => {
  if (!activeFile) return;
  const titleEl = document.getElementById('content-title');
  const current = activeFile.replace(/\.md$/, '');
  titleEl.innerHTML = `<input id="rename-input" value="${esc(current)}">`;
  const input = document.getElementById('rename-input');
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim();
    if (newName && newName !== current) {
      await renamePlan(activeFile, newName);
    } else {
      titleEl.textContent = current;
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') { titleEl.textContent = current; }
  });
  input.addEventListener('blur', finish);
};

// keyboard: ctrl+s to save in edit mode
document.addEventListener('keydown', e => {
  if (editing && (e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    document.getElementById('btn-save').click();
  }
});

// toolbar commands
document.getElementById('edit-toolbar').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  if (!cmd) return;
  e.preventDefault();
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
  document.getElementById('content').focus();
});

// paste as plain text to avoid injecting unwanted HTML
document.getElementById('content').addEventListener('paste', e => {
  if (!editing) return;
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});

// pwa
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

loadPlans();
