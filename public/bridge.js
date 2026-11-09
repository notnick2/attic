// The interface only ever talks to window.store. A desktop shell can provide it;
// otherwise it is backed by the local server.
if (window.store) {
  document.documentElement.classList.add('desktop');
} else {
  new EventSource('/api/alive'); // lets the server know when this window has closed

  const put = (board, keepalive = false) =>
    fetch('/api/board', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(board),
      keepalive,
    });

  window.store = {
    async load() {
      const response = await fetch('/api/board');
      if (!response.ok) throw new Error(`load failed: ${response.status}`);
      return response.json();
    },
    async save(board) {
      const response = await put(board);
      if (!response.ok) throw new Error(`save failed: ${response.status}`);
    },
    saveNow(board) {
      put(board, true).catch(() => {});
    },
  };
}
