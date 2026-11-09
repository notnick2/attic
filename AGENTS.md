# Working on Attic

Attic is personal software: a local-first app its owner reshapes by asking a coding agent. Today it is a kanban board.

## Run

`npm start` launches the server and an Edge app window on Windows. Requires Node 22+.

For anything that writes data, use a throwaway location so the owner's real board stays untouched:

```powershell
$env:ATTIC_HOME = "$env:TEMP\attic-test"; $env:PORT = "4480"; node server.js
```

Then open `http://127.0.0.1:4480/`. Without a connected window the server exits after 60 seconds.

## Layout

- `public/app.js`: board state, rendering keyed by id, drag and drop, debounced saving
- `public/detail.js`: task panel
- `public/calendar.js`: date and time picker
- `public/dither.js`: animated `field()`, CSS tiles, `dissolve()`
- `public/dom.js`: small DOM helpers
- `public/bridge.js`: defines `window.store`
- `server.js`: static files, `/api/board`, window launch, exit when the window closes
- `store.js`: atomic writes, daily backups, board validation
- `main.js`, `preload.cjs`: Electron shell, not yet run

## Data

`%APPDATA%\Attic\data\board.json`:

```json
{
  "version": 1,
  "columns": [
    {
      "id": "string",
      "title": "string",
      "tasks": [
        { "id": "string", "text": "string", "createdAt": 0, "tags": ["string"], "dueAt": 0 }
      ]
    }
  ]
}
```

`createdAt`, `tags` and `dueAt` are optional. Keep new fields optional too, so existing boards keep loading.

## Rules

- Keep runtime dependencies at zero and do not add a build step.
- The interface reaches storage only through `window.store` (`load`, `save`, `saveNow`).
- Register every new file in `public/` in `STATIC` in `server.js` and `ASSETS` in `main.js`. Both are allowlists, and a restart is needed to pick up a new file.
- Build dithered visuals with `public/dither.js`. Keep them subtle, and use grey rather than the accent colour.
- Mutate state, then call `commit()`, which re-renders and schedules a save.
- Respect `prefers-reduced-motion`.
