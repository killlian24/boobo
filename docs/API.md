# Boobo – API- und Architekturvertrag

Boobo ist ein Still-Tracker für zwei Eltern, läuft als ein Docker-Container auf einem NAS (Portainer),
LAN-only über http://NAS-IP:8099. Keine Benutzer, keine Authentifizierung.

## Stack (verbindlich)
- Node.js 24, **keine npm-Abhängigkeiten** (kein `node_modules`, kein `npm install` im Build).
- HTTP-Server mit `node:http`, Datenbank mit `node:sqlite` (`DatabaseSync`), Datei `${DATA_DIR}/boobo.db`.
- Statische Dateien aus `public/` ausliefern (Root `/` → `public/index.html`), korrekte MIME-Types,
  `Cache-Control: no-cache` für HTML/sw.js/manifest, kurzes Caching für Rest ist ok.
- Umgebungsvariablen: `PORT` (Default 8099), `DATA_DIR` (Default `./data`), `FEED_INTERVAL_MINUTES` (Default 180),
  `TZ` wird nur fürs Logging genutzt; alle Zeiten in der API sind ISO-8601 **UTC** (`...Z`). Der Client formatiert lokal.
- Alles in einer Datei `server.js` (plus optional `lib/*.js`). ESM (`"type": "module"` in package.json).
- Läuft als non-root im Container, hört auf `0.0.0.0`.

## Datenmodell
Tabelle `feeds`:
| Spalte | Typ | Bedeutung |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| side | TEXT NOT NULL | `left` \| `right` \| `both` \| `bottle` |
| at | TEXT NOT NULL | ISO-8601 UTC, Zeitpunkt des Stillens (Beginn) |
| note | TEXT NULL | Freitext, optional |
| created_at | TEXT NOT NULL | ISO-8601 UTC |
| updated_at | TEXT NOT NULL | ISO-8601 UTC |

Tabelle `settings` (key TEXT PK, value TEXT): aktuell nur `interval_minutes` (Default aus `FEED_INTERVAL_MINUTES`).

Alle JSON-Antworten: `Content-Type: application/json; charset=utf-8`. Fehler: `{ "error": "message" }` mit 400/404/500.
CORS: `Access-Control-Allow-Origin: *` auf `/api/*` (damit Home Assistant und Tests problemlos lesen), OPTIONS beantworten.

## Endpunkte

### `GET /api/health`
→ `200 { "ok": true, "version": "1.0.0", "time": "<now ISO>" }`

### `GET /api/state`  (für Home Assistant und für die Startseite)
```json
{
  "now": "2026-10-31T17:00:00.000Z",
  "interval_minutes": 180,
  "last": { "id": 12, "side": "left", "at": "2026-10-31T15:42:00.000Z", "note": null } ,   // oder null wenn noch kein Eintrag
  "minutes_since_last": 78,            // null wenn kein Eintrag; ganzzahlig, abgerundet
  "next_due_at": "2026-10-31T18:42:00.000Z",   // last.at + interval; null wenn kein Eintrag
  "minutes_until_due": 102,            // negativ wenn überfällig; null wenn kein Eintrag
  "overdue": false,
  "suggested_side": "right",           // nächste Brust: Gegenseite der letzten Brust-Seite (left→right, right→left, both→left, bottle→letzte Brustseite umgedreht; kein Eintrag→"left")
  "today_count": 7,                    // Einträge seit lokaler Mitternacht (Server-TZ via TZ-Env, Default Europe/Berlin)
  "last_24h_count": 9
}
```

### `GET /api/feeds?limit=50&before=<ISO>`
→ `200 { "feeds": [ {id, side, at, note, created_at, updated_at}, ... ] }` sortiert nach `at` absteigend. `limit` max 500, Default 50.

### `POST /api/feeds`
Body: `{ "side": "left", "at": "<ISO optional, Default now>", "note": "optional" }`
→ `201 { "feed": {...} }`. Validierung: side ∈ Menge, `at` gültiges Datum und nicht mehr als 5 Minuten in der Zukunft.

### `PATCH /api/feeds/:id`
Body: beliebige Teilmenge von `{ side, at, note }` → `200 { "feed": {...} }`, 404 wenn nicht vorhanden.

### `DELETE /api/feeds/:id`
→ `204`. 404 wenn nicht vorhanden.

### `GET /api/settings` → `200 { "interval_minutes": 180 }`
### `PUT /api/settings` Body `{ "interval_minutes": 150 }` (30..720) → `200 { "interval_minutes": 150 }`

### `GET /api/export.csv`
CSV aller Einträge (`id,side,at,note`), `Content-Disposition: attachment; filename="boobo-export.csv"`.

## Frontend-Verhalten (public/)
- Vanilla HTML/CSS/JS, keine Frameworks, keine CDN-Abhängigkeiten, Sprache Deutsch.
- PWA: `manifest.webmanifest`, `sw.js` (nur registrieren wenn `window.isSecureContext`; auf http im LAN still überspringen),
  Icons als SVG (`icon.svg`) plus PNG 192/512 (dürfen generiert werden; falls nicht möglich, SVG mit `purpose: any`).
- Startseite: große Statusanzeige (Zuletzt: Uhrzeit · Seite · „vor 1 h 12 min“), Fortschrittsring/Balken bis zur nächsten fälligen Mahlzeit,
  wird deutlich hervorgehoben, wenn die Zeit um ist („Bobo hat bestimmt Hunger“, siehe docs/COPY.md). Vorgeschlagene nächste Seite hervorheben.
- Vier große Buttons: **Links**, **Rechts**, **Beide**, **Flasche**. Ein Tipp = `POST /api/feeds` mit jetzt. Danach Toast mit „Rückgängig“ (10 s) → `DELETE`.
- Verlauf: Liste der letzten Einträge gruppiert nach Tag, mit Abstand zum vorherigen Eintrag. Tippen auf Eintrag → Zeit/Seite/Notiz ändern oder löschen (`PATCH`/`DELETE`).
- „Nachtragen“: Eintrag mit manuell gewählter Uhrzeit anlegen.
- Einstellungen: Intervall in Minuten (PUT /api/settings), CSV-Export-Link.
- Auto-Refresh: `GET /api/state` + Verlauf alle 30 s und bei `visibilitychange`, damit beide Handys synchron sind. Relative Zeiten jede Minute neu rendern.
- Design: ruhig, warm, groß, nachttauglich (dunkles Farbschema via `prefers-color-scheme`, Buttons mind. 72 px hoch, nutzbar mit einer Hand).
