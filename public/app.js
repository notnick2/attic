import { dueState, formatFull, formatShort } from './calendar.js';
import { createDetail } from './detail.js';
import { colors, dissolve, field, installTiles, reducedMotion } from './dither.js';
import { grow, make } from './dom.js';

const $ = (selector, root = document) => root.querySelector(selector);

const board = $('#board');
const statusEl = $('#status');
const toastEl = $('#toast');

let state = null;
const nodes = new Map(); // column or task id -> element
let drag = null;
let booted = false;

const uid = () => crypto.randomUUID();
const findColumn = (id) => state.columns.find((c) => c.id === id);

function findTask(id) {
  for (const column of state.columns) {
    const index = column.tasks.findIndex((t) => t.id === id);
    if (index >= 0) return { column, index, task: column.tasks[index] };
  }
  return null;
}

/* ---------- saving ---------- */

let saveTimer = null;
let saving = false;
let saveAgain = false;
let saveFailed = false;
let syncSpeed = 0.6;

function setStatus(text, bad = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('bad', bad);
  syncSpeed = text === 'saving' ? 5 : 0.6;
  markField?.setColor(bad ? colors.accent : colors.ink);
}

function scheduleSave() {
  if (!saveFailed) setStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 150);
}

async function flushSave() {
  saveTimer = null;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    await window.store.save(state);
    saveFailed = false;
  } catch (err) {
    console.error(err);
    saveFailed = true;
  }
  saving = false;
  if (saveFailed) {
    setStatus('not saved, retrying', true);
    saveTimer = setTimeout(flushSave, 3000);
  } else if (saveAgain) {
    saveAgain = false;
    flushSave();
  } else if (!saveTimer) {
    setStatus('saved');
  }
}

function commit() {
  render();
  scheduleSave();
}

// Closing the window mid-edit still writes the latest board before the app exits.
addEventListener('pagehide', () => {
  if (saveTimer || saving || saveAgain) window.store.saveNow(state);
});

// If the app was opened twice, a window catches up with the other when it regains focus.
addEventListener('focus', async () => {
  const busy = () => !state || drag || saveTimer || saving || saveFailed || $('.editing') || detail.isOpen();
  if (busy()) return;
  try {
    const next = await window.store.load();
    if (busy() || JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    render();
  } catch (err) {
    console.error(err);
  }
});

/* ---------- rendering: keyed by id so only what changed moves or dissolves ---------- */

// Next sibling that will stay, ignoring elements on their way out.
function nextLive(el) {
  let next = el.nextElementSibling;
  while (next?.classList.contains('leaving')) next = next.nextElementSibling;
  return next;
}

function arrange(parent, children, tail = null) {
  let ref = tail;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.parentElement !== parent || nextLive(child) !== ref) parent.insertBefore(child, ref);
    ref = child;
  }
}

async function leave(el, axis) {
  el.classList.add('leaving');
  el.style.pointerEvents = 'none';
  await dissolve(el, 'out', 200);
  if (!reducedMotion) {
    const size = el.getBoundingClientRect()[axis];
    const frames = axis === 'height'
      ? [{ height: `${size}px`, paddingTop: '', paddingBottom: '' }, { height: '0px', paddingTop: 0, paddingBottom: 0, marginTop: '-6px' }]
      : [{ width: `${size}px` }, { width: '0px', marginLeft: '-10px' }];
    el.style.overflow = 'hidden';
    el.style.visibility = 'hidden';
    await el.animate(frames, { duration: 130, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {});
  }
  el.remove();
}

function render() {
  if (drag) return;
  const live = new Set();

  const columnEls = state.columns.map((column) => {
    live.add(column.id);
    let el = nodes.get(column.id);
    const fresh = !el;
    if (fresh) {
      el = createColumn(column.id);
      nodes.set(column.id, el);
    }
    syncColumn(el, column, live);
    if (fresh && booted) dissolve(el, 'in', 260);
    return el;
  });

  arrange(board, columnEls, addColumnEl);

  for (const [id, el] of nodes) {
    if (live.has(id)) continue;
    nodes.delete(id);
    if (el.classList.contains('col')) leave(el, 'width');
    else if (!el.closest('.leaving')) leave(el, 'height');
  }

  detail.sync();
}

function syncMeta(node, task) {
  const signature = JSON.stringify([task.tags ?? [], task.dueAt ? [formatShort(task.dueAt), dueState(task.dueAt)] : null]);
  if (node.metaSignature === signature) return;
  node.metaSignature = signature;
  const parts = (task.tags ?? []).map((tag) => make('span', 'tag', tag));
  if (task.dueAt) {
    const due = make('span', `due ${dueState(task.dueAt)}`.trim(), formatShort(task.dueAt));
    due.title = `Due ${formatFull(task.dueAt)}`;
    parts.push(due);
  }
  node.metaEl.replaceChildren(...parts);
  node.metaEl.hidden = !parts.length;
}

function syncColumn(el, column, live) {
  if (!el.classList.contains('renaming')) el.titleEl.textContent = column.title;
  el.countEl.textContent = column.tasks.length;
  el.setLoad(column.tasks.length);

  const taskEls = column.tasks.map((task) => {
    live.add(task.id);
    let node = nodes.get(task.id);
    const fresh = !node;
    if (fresh) {
      node = createTask(task.id);
      nodes.set(task.id, node);
    }
    node.textEl.textContent = task.text;
    node.setAttribute('aria-label', task.text);
    syncMeta(node, task);
    if (fresh && booted) dissolve(node, 'in', 240);
    return node;
  });

  arrange(el.list, taskEls);
}

/* ---------- columns ---------- */

function createColumn(id) {
  const el = make('section', 'col');
  el.dataset.id = id;

  const head = make('header', 'col-head');
  el.titleEl = make('h2', 'col-title');
  el.countEl = make('span', 'col-count');
  const del = make('button', 'x col-del', '×');
  del.setAttribute('aria-label', 'Delete column');
  del.addEventListener('click', () => removeColumn(id));
  head.append(el.titleEl, el.countEl, del);
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input')) return;
    press(e, el, 'column', () => renameColumn(el));
  });

  const band = make('div', 'band');
  const canvas = make('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  band.append(canvas);

  el.list = make('ul', 'tasks');

  const composerEl = make('div', 'composer');
  composer(composerEl, {
    label: '+ task',
    placeholder: 'Dump it here',
    multiline: true,
    onSubmit(text) {
      const target = findColumn(id);
      if (!target) return;
      target.tasks.push({ id: uid(), text, createdAt: Date.now() });
      commit();
      el.list.scrollTop = el.list.scrollHeight;
    },
  });

  el.append(head, band, el.list, composerEl);

  // The band under each title gets denser and longer as the column fills up.
  let target = 0;
  let current = 0;
  el.band = field(canvas, {
    cell: 2,
    fps: 10,
    color: colors.ink,
    frame() {
      current = reducedMotion ? target : current + (target - current) * 0.22;
    },
    shade(x, y, t, w, h) {
      const reach = Math.min(1, (current + 0.06 - x / w) / 0.3);
      if (reach <= 0) return 0;
      return reach * (0.62 + 0.18 * Math.sin(x * 0.5 - t * 1.6)) * (0.6 + (0.4 * y) / h);
    },
  });
  el.setLoad = (count) => {
    target = Math.min(1, count / 10);
    el.band.invalidate();
  };

  return el;
}

function renameColumn(el) {
  const column = findColumn(el.dataset.id);
  if (!column || el.classList.contains('renaming')) return;
  el.classList.add('renaming', 'editing');
  const input = make('input', 'field');
  input.value = column.title;
  input.setAttribute('aria-label', 'Column name');
  el.titleEl.hidden = true;
  el.titleEl.after(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    el.titleEl.hidden = false;
    el.classList.remove('renaming', 'editing');
    if (save && value && value !== column.title) {
      column.title = value;
      commit();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function removeColumn(id) {
  const index = state.columns.findIndex((c) => c.id === id);
  if (index < 0) return;
  const [column] = state.columns.splice(index, 1);
  commit();
  offerUndo(`Deleted ${column.title}`, () => {
    state.columns.splice(Math.min(index, state.columns.length), 0, column);
    commit();
  });
}

/* ---------- tasks ---------- */

function createTask(id) {
  const el = make('li', 'task');
  el.dataset.id = id;
  el.tabIndex = 0;

  el.textEl = make('div', 'text');
  el.metaEl = make('div', 'meta');
  el.metaEl.hidden = true;
  const del = make('button', 'x', '×');
  del.setAttribute('aria-label', 'Delete task');
  del.addEventListener('click', () => removeTask(id));
  el.append(el.textEl, el.metaEl, del);

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    press(e, el, 'task', () => detail.open(id, el));
  });
  el.addEventListener('keydown', (e) => taskKeys(e, el));

  return el;
}

function taskKeys(event, el) {
  if (event.target !== el) return;
  const id = el.dataset.id;
  if (event.key === 'Enter') {
    event.preventDefault();
    detail.open(id, el);
  } else if (event.key === 'Delete') {
    removeTask(id);
  } else if (event.altKey && event.key.startsWith('Arrow')) {
    event.preventDefault();
    moveByKey(el, event.key.slice(5));
  }
}

function moveByKey(el, direction) {
  const found = findTask(el.dataset.id);
  if (!found) return;
  const { column, index, task } = found;
  let to = column;
  let at = index;
  if (direction === 'Up') at = index - 1;
  if (direction === 'Down') at = index + 1;
  if (direction === 'Left' || direction === 'Right') {
    to = state.columns[state.columns.indexOf(column) + (direction === 'Left' ? -1 : 1)];
    if (!to) return;
    at = Math.min(index, to.tasks.length);
  }
  if (to === column && (at < 0 || at >= column.tasks.length)) return;
  column.tasks.splice(index, 1);
  to.tasks.splice(at, 0, task);
  commit();
  el.focus();
  dissolve(el, 'in', 160);
}

function removeTask(id) {
  const found = findTask(id);
  if (!found) return;
  detail.closeIf(id);
  const { column, index, task } = found;
  column.tasks.splice(index, 1);
  commit();
  offerUndo(`Deleted ${task.text.split('\n')[0]}`, () => {
    const home = findColumn(column.id) ?? state.columns[0];
    if (!home) return;
    home.tasks.splice(Math.min(index, home.tasks.length), 0, task);
    commit();
  });
}

/* ---------- inline composer, shared by "+ task" and "+ column" ---------- */

function composer(host, { label, placeholder, multiline, onSubmit }) {
  const button = make('button', 'add', label);
  host.append(button);
  let input = null;

  const close = () => {
    if (!input) return;
    const el = input;
    input = null;
    el.remove();
    button.hidden = false;
  };

  const submit = () => {
    const value = input.value.trim();
    if (!value) return false;
    input.value = '';
    if (multiline) grow(input);
    onSubmit(value);
    return true;
  };

  const open = () => {
    input = make(multiline ? 'textarea' : 'input', 'field');
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    if (multiline) input.rows = 1;
    button.hidden = true;
    host.append(input);
    input.focus();
    dissolve(input, 'in', 140);

    input.addEventListener('input', (e) => multiline && grow(e.target));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!submit()) close();
      } else if (e.key === 'Escape') {
        close();
        button.focus();
      }
    });
    input.addEventListener('blur', () => {
      if (!input) return;
      submit(); // leaving the box should never lose a half-typed thought
      close();
    });
  };

  button.addEventListener('click', open);
}

const addColumnEl = make('div', 'add-col');
composer(addColumnEl, {
  label: '+ column',
  placeholder: 'Column name',
  multiline: false,
  onSubmit(title) {
    state.columns.push({ id: uid(), title, tasks: [] });
    commit();
    board.scrollLeft = board.scrollWidth;
  },
});

/* ---------- undo ---------- */

let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
  toastEl.replaceChildren();
}

function offerUndo(message, undo) {
  hideToast();
  const button = make('button', '', 'undo');
  button.addEventListener('click', () => {
    hideToast();
    undo();
  });
  toastEl.append(make('span', '', message), button);
  toastEl.hidden = false;
  dissolve(toastEl, 'in', 180);
  toastTimer = setTimeout(hideToast, 8000);
}

/* ---------- drag ---------- */

function press(event, el, kind, onClick) {
  if (event.button !== 0 || drag) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let active = false;

  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    removeEventListener('keydown', key);
  };
  const move = (e) => {
    if (!active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      active = true;
      startDrag(el, kind, startX, startY);
    }
    dragTo(e.clientX, e.clientY);
  };
  const up = (e) => {
    cleanup();
    if (active) endDrag(e.type === 'pointerup');
    else if (e.type === 'pointerup') onClick();
  };
  const key = (e) => {
    if (e.key !== 'Escape' || !active) return;
    cleanup();
    endDrag(false);
  };

  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  addEventListener('keydown', key);
}

function startDrag(el, kind, x, y) {
  const rect = el.getBoundingClientRect();

  const ghost = make('div', 'ghost');
  const clone = el.cloneNode(true);
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  el.querySelectorAll('canvas').forEach((source, i) => {
    const copy = clone.querySelectorAll('canvas')[i];
    copy.width = source.width;
    copy.height = source.height;
    copy.style.cssText = source.style.cssText;
    copy.getContext('2d').drawImage(source, 0, 0);
  });
  ghost.append(clone);
  document.body.append(ghost);

  const slot = make(kind === 'task' ? 'li' : 'div', `slot slot-${kind}`);
  slot.style.height = `${rect.height}px`;
  const canvas = make('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  slot.append(canvas);
  el.before(slot);
  el.classList.add('lifted');

  const slotField = field(canvas, {
    cell: 2,
    fps: 8,
    color: colors.accent,
    shade: (px, py, t) => 0.14 + 0.06 * Math.sin((px + py) * 0.16 - t * 1.2),
  });

  document.body.classList.add('dragging');
  drag = { kind, el, ghost, slot, slotField, offsetX: x - rect.left, offsetY: y - rect.top, x, y, target: null };
  autoScroll();
}

function dragTo(x, y) {
  drag.x = x;
  drag.y = y;
  drag.ghost.style.transform = `translate(${x - drag.offsetX}px, ${y - drag.offsetY}px)`;
  locate();
}

const liveColumns = () => [...board.querySelectorAll('.col:not(.lifted):not(.leaving)')];
const liveTasks = (list) => [...list.querySelectorAll('.task:not(.lifted):not(.leaving)')];

function nextCounted(slot) {
  let next = slot.nextElementSibling;
  while (next?.matches('.lifted, .leaving')) next = next.nextElementSibling;
  return next;
}

function nearestColumn(x) {
  let best = null;
  let bestDistance = Infinity;
  for (const column of liveColumns()) {
    const rect = column.getBoundingClientRect();
    const distance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = column;
    }
  }
  return best;
}

function setTarget(column) {
  if (drag.target === column) return;
  if (drag.target) {
    drag.target.classList.remove('target');
    drag.target.band.setColor(colors.ink);
  }
  drag.target = column;
  if (column) {
    column.classList.add('target');
    column.band.setColor(colors.accent);
  }
}

function locate() {
  const { kind, slot, x, y } = drag;

  if (kind === 'column') {
    const before = liveColumns().find((c) => {
      const r = c.getBoundingClientRect();
      return x < r.left + r.width / 2;
    }) ?? addColumnEl;
    if (nextCounted(slot) !== before) flip([board], () => board.insertBefore(slot, before));
    return;
  }

  const column = nearestColumn(x);
  if (!column) return;
  setTarget(column);
  const list = column.list;
  const before = liveTasks(list).find((t) => {
    const r = t.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) ?? null;
  if (slot.parentElement === list && nextCounted(slot) === before) return;
  flip([...new Set([slot.parentElement, list])], () => list.insertBefore(slot, before));
}

// Lets neighbouring cards glide to their new spots when the slot moves.
function flip(parents, mutate) {
  if (reducedMotion) return mutate();
  const items = parents.flatMap((p) => [...p.children].filter((c) => c.matches('.task:not(.lifted), .col:not(.lifted)')));
  const first = new Map(items.map((item) => [item, item.getBoundingClientRect()]));
  mutate();
  for (const item of items) {
    const before = first.get(item);
    const after = item.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (dx || dy) {
      item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: 140,
        easing: 'cubic-bezier(.2,.8,.2,1)',
      });
    }
  }
}

function edgeSpeed(position, start, end) {
  const edge = 70;
  if (position < start + edge) return -Math.min(1, (start + edge - position) / edge) * 14;
  if (position > end - edge) return Math.min(1, (position - end + edge) / edge) * 14;
  return 0;
}

function autoScroll() {
  if (!drag) return;
  const area = board.getBoundingClientRect();
  const dx = edgeSpeed(drag.x, area.left, area.right);
  let moved = false;
  if (dx) {
    const before = board.scrollLeft;
    board.scrollLeft += dx;
    moved = board.scrollLeft !== before;
  }
  const list = drag.target?.list;
  if (list) {
    const box = list.getBoundingClientRect();
    const dy = edgeSpeed(drag.y, box.top, box.bottom);
    if (dy) {
      const before = list.scrollTop;
      list.scrollTop += dy;
      moved = moved || list.scrollTop !== before;
    }
  }
  if (moved) locate();
  drag.scroll = requestAnimationFrame(autoScroll);
}

function applyDrop() {
  const { kind, el, slot } = drag;

  if (kind === 'column') {
    const from = state.columns.findIndex((c) => c.id === el.dataset.id);
    let to = 0;
    for (let prev = slot.previousElementSibling; prev; prev = prev.previousElementSibling) {
      if (prev.matches('.col:not(.lifted):not(.leaving)')) to++;
    }
    if (from < 0 || from === to) return false;
    const [column] = state.columns.splice(from, 1);
    state.columns.splice(to, 0, column);
    return true;
  }

  const found = findTask(el.dataset.id);
  const destination = findColumn(slot.closest('.col').dataset.id);
  if (!found || !destination) return false;
  let to = 0;
  for (let prev = slot.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (prev.matches('.task:not(.lifted):not(.leaving)')) to++;
  }
  if (found.column === destination && found.index === to) return false;
  found.column.tasks.splice(found.index, 1);
  destination.tasks.splice(to, 0, found.task);
  return true;
}

async function endDrag(drop) {
  const current = drag;
  cancelAnimationFrame(current.scroll);
  setTarget(null);
  const changed = drop && applyDrop();
  if (!drop) current.el.before(current.slot);

  const home = current.slot.getBoundingClientRect();
  if (!reducedMotion) {
    await current.ghost
      .animate([{ transform: current.ghost.style.transform || 'none' }, { transform: `translate(${home.left}px, ${home.top}px)` }], {
        duration: 120,
        easing: 'cubic-bezier(.2,.8,.2,1)',
        fill: 'forwards',
      })
      .finished.catch(() => {});
  }

  current.ghost.remove();
  current.slotField.stop();
  current.slot.replaceWith(current.el);
  current.el.classList.remove('lifted');
  document.body.classList.remove('dragging');
  drag = null;
  render();
  if (changed) {
    scheduleSave();
    dissolve(current.el, 'in', 180);
  }
}

/* ---------- ambient dither ---------- */

function startBackground() {
  field($('#field'), {
    cell: 4,
    fps: 10,
    color: colors.ink,
    shade(x, y, t, w, h) {
      const rise = Math.max(0, y / h - 0.34) / 0.66;
      if (!rise) return 0;
      const flow =
        0.62 +
        0.26 * Math.sin(x * 0.021 + t * 0.13 + 1.6 * Math.sin(y * 0.035 - t * 0.08)) +
        0.16 * Math.sin((x - y) * 0.013 + t * 0.1);
      return rise * rise * 0.62 * flow;
    },
  });
}

let markField = null;

function startMark() {
  let phase = 0;
  let previous = 0;
  markField = field($('#mark'), {
    cell: 2,
    fps: 14,
    color: colors.ink,
    frame(t) {
      phase += (t - previous) * syncSpeed;
      previous = t;
    },
    shade(x, y, t, w, h) {
      const r = Math.hypot(x - (w - 1) / 2, y - (h - 1) / 2) / (w / 2);
      return 1.02 - r * 1.05 + 0.24 * Math.sin(phase * 2 - r * 6);
    },
  });
}

/* ---------- boot ---------- */

const detail = createDetail({
  findTask,
  commit,
  removeTask,
  allTasks: () => state.columns.flatMap((column) => column.tasks),
  isDragging: () => Boolean(drag),
});

async function boot() {
  installTiles();
  board.append(addColumnEl);
  startBackground();
  startMark();

  try {
    state = await window.store.load();
  } catch (err) {
    console.error(err);
    // Nothing renders here, so a broken load can never overwrite the saved board.
    setStatus('not loaded', true);
    board.replaceChildren(make('p', 'fatal', "Can't read your board file. Nothing has been changed."));
    return;
  }

  render();
  setStatus('saved');
  booted = true;
  setInterval(render, 60_000); // keeps "Today", "soon" and "overdue" labels current
  dissolve($('#app'), 'in', 520);
}

boot();
