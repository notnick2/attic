import { colors, dissolve, field } from './dither.js';
import { make } from './dom.js';

const DAY = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_MINUTES = 17 * 60;
const STEP = 5;

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const timeLabel = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const formatFull = (ms) =>
  new Date(ms).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function formatShort(ms) {
  const due = new Date(ms);
  const today = midnight(new Date());
  const days = Math.round((midnight(due) - today) / DAY);
  if (days === 0) return `Today ${timeLabel(due)}`;
  if (days === 1) return `Tomorrow ${timeLabel(due)}`;
  if (days === -1) return `Yesterday ${timeLabel(due)}`;
  const options = { day: 'numeric', month: 'short' };
  if (due.getFullYear() !== today.getFullYear()) options.year = 'numeric';
  return `${due.toLocaleDateString([], options)}, ${timeLabel(due)}`;
}

export function dueState(ms) {
  const left = ms - Date.now();
  if (left < 0) return 'overdue';
  return left < DAY ? 'soon' : '';
}

// A month grid and a dithered "daylight" bar for the time of day.
// taskDays() returns a Set of day keys that already have a deadline.
export function createDuePicker({ value, onChange, taskDays }) {
  const initial = value ? new Date(value) : null;
  let date = initial ? midnight(initial) : null;
  let minutes = initial ? initial.getHours() * 60 + initial.getMinutes() : DEFAULT_MINUTES;
  let view = new Date((date ?? new Date()).getFullYear(), (date ?? new Date()).getMonth(), 1);

  const root = make('div', 'picker');

  const emit = () => {
    onChange(date ? new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60).getTime() : null);
  };

  /* quick picks */
  const quick = make('div', 'quick');
  const quickButton = (label, pick) => {
    const button = make('button', 'quick-pick', label);
    button.type = 'button';
    button.addEventListener('click', pick);
    quick.append(button);
  };
  const today = () => midnight(new Date());
  quickButton('Today', () => pickDay(today()));
  quickButton('Tomorrow', () => pickDay(addDays(today(), 1)));
  quickButton('Next week', () => pickDay(addDays(today(), 7)));
  quickButton('Clear', () => {
    date = null;
    drawGrid();
    updateTime();
    emit();
  });

  /* month */
  const head = make('div', 'cal-head');
  const monthLabel = make('span', 'cal-month');
  const prev = make('button', 'cal-nav cal-prev', '‹');
  const next = make('button', 'cal-nav cal-next', '›');
  prev.type = next.type = 'button';
  prev.setAttribute('aria-label', 'Previous month');
  next.setAttribute('aria-label', 'Next month');
  prev.addEventListener('click', () => shiftMonth(-1));
  next.addEventListener('click', () => shiftMonth(1));
  head.append(monthLabel, prev, next);

  const weekdays = make('div', 'cal-weekdays');
  WEEKDAYS.forEach((name) => weekdays.append(make('span', '', name)));

  const grid = make('div', 'cal-grid');

  function drawGrid() {
    monthLabel.textContent = view.toLocaleDateString([], { month: 'long', year: 'numeric' });
    const offset = (view.getDay() + 6) % 7;
    const todayKey = dayKey(new Date());
    const selectedKey = date ? dayKey(date) : null;
    const busy = taskDays();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(view.getFullYear(), view.getMonth(), 1 - offset + i);
      const key = dayKey(cellDate);
      const cell = make('button', 'day', cellDate.getDate());
      cell.type = 'button';
      cell.dataset.date = key;
      cell.setAttribute('aria-label', cellDate.toLocaleDateString([], { dateStyle: 'full' }));
      cell.setAttribute('aria-pressed', key === selectedKey);
      cell.classList.toggle('out', cellDate.getMonth() !== view.getMonth());
      cell.classList.toggle('today', key === todayKey);
      cell.classList.toggle('selected', key === selectedKey);
      cell.classList.toggle('has', busy.has(key));
      cell.addEventListener('click', () => pickDay(cellDate));
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
  }

  function shiftMonth(by) {
    view = new Date(view.getFullYear(), view.getMonth() + by, 1);
    drawGrid();
    dissolve(grid, 'in', 160);
  }

  function pickDay(day) {
    date = midnight(day);
    view = new Date(date.getFullYear(), date.getMonth(), 1);
    drawGrid();
    const selected = grid.querySelector('.selected');
    if (selected) dissolve(selected, 'in', 200);
    updateTime();
    emit();
  }

  /* time */
  const readout = make('div', 'time-readout');
  const dayText = make('span', 'time-day');
  const timeInput = make('input', 'time-input');
  timeInput.type = 'time';
  timeInput.setAttribute('aria-label', 'Time');
  timeInput.addEventListener('change', () => {
    if (!timeInput.value) return;
    const [hours, mins] = timeInput.value.split(':').map(Number);
    setMinutes(hours * 60 + mins, false);
  });
  readout.append(dayText, timeInput);

  const bar = make('div', 'timebar');
  bar.tabIndex = 0;
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-label', 'Time of day');
  bar.setAttribute('aria-valuemin', 0);
  bar.setAttribute('aria-valuemax', 1435);
  const canvas = make('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const handle = make('span', 'timebar-handle');
  bar.append(canvas, handle);

  const ticks = make('div', 'timebar-ticks');
  ['12a', '6a', '12p', '6p', '12a'].forEach((label) => ticks.append(make('span', '', label)));

  function updateTime() {
    const clock = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
    handle.style.left = `${(minutes / 1440) * 100}%`;
    timeInput.value = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    bar.setAttribute('aria-valuenow', minutes);
    bar.setAttribute('aria-valuetext', timeLabel(clock));
    dayText.textContent = date
      ? date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })
      : 'Pick a day';
  }

  function setMinutes(next, snap = true) {
    const rounded = snap ? Math.round(next / STEP) * STEP : next;
    minutes = Math.max(0, Math.min(1439, rounded));
    updateTime();
    emit();
  }

  const fromPointer = (event) => {
    const rect = bar.getBoundingClientRect();
    setMinutes(((event.clientX - rect.left) / rect.width) * 1440);
  };

  bar.addEventListener('pointerdown', (event) => {
    bar.setPointerCapture(event.pointerId);
    bar.focus();
    fromPointer(event);
  });
  bar.addEventListener('pointermove', (event) => {
    if (bar.hasPointerCapture(event.pointerId)) fromPointer(event);
  });
  bar.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: -STEP, ArrowRight: STEP, ArrowDown: -60, ArrowUp: 60 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setMinutes(minutes + moves[event.key]);
  });

  root.append(quick, head, weekdays, grid, readout, bar, ticks);
  drawGrid();
  updateTime();

  // Grain follows the sun: dark at night, densest at noon.
  field(canvas, {
    cell: 2,
    fps: 8,
    color: colors.ink,
    shade(x, y, t, width, height) {
      const hour = (x / width) * 24;
      const sun = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12));
      return (0.05 + 0.6 * sun) * (0.45 + (0.55 * y) / height) + 0.03 * Math.sin(x * 0.4 - t * 1.1);
    },
  });

  return root;
}
