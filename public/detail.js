import { createDuePicker, dayKey, formatFull } from './calendar.js';
import { dissolve } from './dither.js';
import { grow, make } from './dom.js';

const MAX_SUGGESTIONS = 8;

const normalizeTag = (raw) =>
  raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 32);

// The panel that opens when a task is clicked: text, tags, deadline and created date.
export function createDetail({ findTask, commit, removeTask, allTasks, isDragging }) {
  const root = make('aside', 'detail');
  root.hidden = true;
  root.setAttribute('aria-label', 'Task details');
  const body = make('div', 'detail-body');
  root.append(body);
  document.body.append(root);

  let current = null;
  let closeToken = 0;

  function build(id, task, opener) {
    const top = make('div', 'detail-top');
    const created = make('span', 'detail-created', task.createdAt ? `Created ${formatFull(task.createdAt)}` : 'Created date unknown');
    const closeButton = make('button', 'x detail-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close details');
    closeButton.addEventListener('click', () => close(true));
    top.append(created, closeButton);

    const title = make('textarea', 'detail-title');
    title.value = task.text;
    title.rows = 1;
    title.setAttribute('aria-label', 'Task text');
    title.addEventListener('input', () => {
      grow(title);
      const value = title.value.trim();
      if (value && value !== task.text) {
        task.text = value;
        commit();
      }
    });
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        title.blur();
      }
    });

    /* tags */
    const tagsLabel = make('h3', 'detail-label', 'Tags');
    const editor = make('div', 'tag-editor');
    const tagInput = make('input', 'tag-input');
    tagInput.placeholder = 'Add a tag';
    tagInput.setAttribute('aria-label', 'Add a tag');
    const suggestions = make('div', 'tag-suggest');

    const tags = () => task.tags ?? [];

    function addTag(raw) {
      const tag = normalizeTag(raw);
      tagInput.value = '';
      if (!tag || tags().includes(tag)) return drawTags();
      task.tags = [...tags(), tag];
      drawTags();
      commit();
    }

    function removeTag(tag) {
      task.tags = tags().filter((t) => t !== tag);
      drawTags();
      commit();
    }

    function drawSuggestions() {
      const typed = normalizeTag(tagInput.value);
      const known = new Set(allTasks().flatMap((t) => t.tags ?? []));
      const options = [...known]
        .filter((tag) => !tags().includes(tag) && tag.includes(typed))
        .sort()
        .slice(0, MAX_SUGGESTIONS);
      const open = document.activeElement === tagInput;
      suggestions.replaceChildren(
        ...(open ? options : []).map((tag) => {
          const option = make('button', 'tag-option', tag);
          option.type = 'button';
          option.addEventListener('pointerdown', (event) => event.preventDefault()); // keep the input focused
          option.addEventListener('click', () => addTag(tag));
          return option;
        }),
      );
    }

    function drawTags() {
      const chips = tags().map((tag) => {
        const chip = make('button', 'chip', tag);
        chip.type = 'button';
        chip.dataset.tag = tag;
        chip.setAttribute('aria-label', `Remove tag ${tag}`);
        chip.addEventListener('click', () => removeTag(tag));
        return chip;
      });
      editor.replaceChildren(...chips, tagInput);
      drawSuggestions();
    }

    tagInput.addEventListener('input', drawSuggestions);
    tagInput.addEventListener('focus', drawSuggestions);
    tagInput.addEventListener('blur', () => {
      if (current?.id !== id) return;
      if (tagInput.value.trim()) addTag(tagInput.value);
      drawSuggestions();
    });
    tagInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        addTag(tagInput.value);
        tagInput.focus();
      } else if (event.key === 'Backspace' && !tagInput.value && tags().length) {
        removeTag(tags().at(-1));
        tagInput.focus();
      }
    });
    editor.addEventListener('click', (event) => {
      if (event.target === editor) tagInput.focus();
    });

    /* deadline */
    const dueLabel = make('h3', 'detail-label', 'Deadline');
    const dueToggle = make('button', 'due-toggle');
    dueToggle.type = 'button';
    const pickerHost = make('div', 'picker-host');
    const drawDue = () => {
      dueToggle.textContent = task.dueAt ? formatFull(task.dueAt) : 'Set a deadline';
      dueToggle.classList.toggle('empty', !task.dueAt);
    };
    dueToggle.addEventListener('click', () => {
      if (pickerHost.firstChild) {
        pickerHost.replaceChildren();
        return;
      }
      const picker = createDuePicker({
        value: task.dueAt,
        taskDays: () => new Set(allTasks().filter((t) => t.dueAt).map((t) => dayKey(new Date(t.dueAt)))),
        onChange(dueAt) {
          if (dueAt) task.dueAt = dueAt;
          else delete task.dueAt;
          drawDue();
          commit();
        },
      });
      pickerHost.append(picker);
      dissolve(picker, 'in', 200);
    });

    const remove = make('button', 'detail-delete', 'Delete task');
    remove.type = 'button';
    remove.addEventListener('click', () => removeTask(id));

    body.replaceChildren(top, title, tagsLabel, editor, suggestions, dueLabel, dueToggle, pickerHost, remove);
    drawTags();
    drawDue();

    current = {
      id,
      opener,
      flush() {
        if (tagInput.value.trim()) addTag(tagInput.value);
      },
      ready() {
        grow(title);
        title.focus();
        title.setSelectionRange(title.value.length, title.value.length);
      },
    };
  }

  function open(id, opener) {
    if (current?.id === id) return;
    const found = findTask(id);
    if (!found) return;
    const switching = Boolean(current);
    current?.flush();
    closeToken++;
    root.hidden = false;
    build(id, found.task, opener);
    current.ready();
    dissolve(switching ? body : root, 'in', switching ? 140 : 200);
  }

  function close(refocus = false) {
    if (!current) return;
    const { opener } = current;
    current.flush();
    current = null;
    const token = ++closeToken;
    if (refocus && opener.isConnected) opener.focus();
    dissolve(root, 'out', 140).then(() => {
      if (token !== closeToken) return;
      root.hidden = true;
      body.replaceChildren();
    });
  }

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current && !isDragging()) close(true);
  });

  document.addEventListener('pointerdown', (event) => {
    if (current && !event.target.closest('.detail, .task, .toast')) close();
  }, true);

  return {
    open,
    close,
    isOpen: () => Boolean(current),
    closeIf(id) {
      if (current?.id === id) close();
    },
    // Called after every render, in case the open task's column was deleted.
    sync() {
      if (current && !findTask(current.id)) close();
    },
  };
}
