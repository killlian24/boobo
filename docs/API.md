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

---

# Erweiterung 2 (Stand 2026-10-31): Doppelschutz, Windeln, Tagesbilanz, Medikamente

Alles Folgende ist **zusätzlich** zum obigen Vertrag. Bestehende Felder und Endpunkte bleiben unverändert
(Home Assistant liest sie bereits). Alle Zeiten weiterhin ISO-8601 UTC.

## 1. Doppelschutz bei `POST /api/feeds`
Zwei Handys tippen nachts oft fast gleichzeitig. Darum:
- Konstante `FEED_DUPLICATE_MINUTES` = 10 (Env, Default 10). Ein „Doppel“ liegt vor, wenn ein bestehender
  Eintrag existiert mit `|existing.at − new.at| < 10 min` (`new.at` = Body-`at` oder jetzt).
- Body bekommt optional `on_duplicate`: `"ask"` (Default) | `"force"` | `"skip"`.
  - `ask`  → bei Doppel `409 { "error": "duplicate", "existing": { feed } }`, nichts gespeichert.
  - `force` → immer speichern, `201` wie bisher.
  - `skip` → bei Doppel `200 { "feed": null, "skipped": true, "existing": { feed } }` (für Home Assistant,
    dort kann niemand nachfragen; HA meldet dann „Schon notiert“).
- `PATCH` ist nicht betroffen.

## 2. Windeln
Tabelle `diapers`: `id`, `kind` (`wet` | `dirty`), `at`, `note`, `created_at`, `updated_at` (wie `feeds`).
- `GET /api/diapers?limit=50&before=<ISO>` → `200 { "diapers": [ {id, kind, at, note, created_at, updated_at} ] }`, `at` absteigend, limit max 500.
- `POST /api/diapers` Body `{ "kind": "wet", "at": "<ISO optional>", "note": "optional" }` → `201 { "diaper": {...} }`.
  Kein Doppelschutz (zwei Windeln kurz hintereinander sind real). Gleiche `at`-Validierung wie bei feeds.
- `PATCH /api/diapers/:id` (Teilmenge von kind/at/note) → `200 { "diaper": {...} }`, `DELETE /api/diapers/:id` → `204`.
- `GET /api/export.csv?what=diapers` → CSV `id,kind,at,note`, Dateiname `boobo-windeln.csv`. Ohne `what` wie bisher (feeds).

## 3. Tagesbilanz: `summary_24h` in `GET /api/state`
Neues Feld (zusätzlich zu `today_count` / `last_24h_count`, die bleiben):
```json
"summary_24h": {
  "feeds": 9,                  // alle Einträge mit at > now − 24 h
  "breast": 7,                 // davon left/right/both
  "bottle": 2,
  "longest_gap_minutes": 220,  // größte Lücke zwischen aufeinanderfolgenden Einträgen im Fenster, inkl. der laufenden Lücke seit dem letzten Eintrag; null wenn kein Eintrag im Fenster
  "avg_gap_minutes": 165,      // Mittel der Lücken zwischen Einträgen im Fenster (ohne laufende Lücke); null wenn < 2 Einträge
  "diapers_wet": 5,
  "diapers_dirty": 2
}
```

## 4. Medikamente (für Mama)
Tabelle `medications`:
| Spalte | Typ | Bedeutung |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT NOT NULL | 1..60 Zeichen, z. B. „Paracetamol“ |
| dose | TEXT NULL | ≤ 40 Zeichen, z. B. „1 g“ |
| max_per_day | INTEGER NULL | Höchstzahl in 24 h (rollierend), 1..24, null = unbegrenzt |
| min_gap_minutes | INTEGER NOT NULL | Mindestabstand zwischen zwei Einnahmen, 0..10080 |
| active | INTEGER NOT NULL DEFAULT 1 | 0 = pausiert (nicht auf der Startseite, keine Erinnerung) |
| sort_order | INTEGER NOT NULL | |
| created_at / updated_at | TEXT | |

Tabelle `med_intakes`: `id`, `medication_id` (FK, ON DELETE CASCADE), `at`, `note`, `created_at`.

**Startbefüllung** einmalig beim ersten Anlegen der Tabelle (Marker `settings.meds_seeded = "1"`):
1. Paracetamol, „1 g“, max 4, Abstand 360 min
2. Ibuprofen, „400 mg“, max 4, Abstand 360 min
3. Magenschutz (PPI), „1 Tablette“, max 1, Abstand 1200 min

**Statusberechnung** pro Medikament (rollierendes 24-h-Fenster, Server-Zeit `now`):
- `taken_24h` = Einnahmen mit `at > now − 24 h`; `last_at` = letzte Einnahme überhaupt (oder null)
- `remaining_24h` = `max_per_day − taken_24h` (null wenn max_per_day null; nie < 0)
- `next_possible_at` = Maximum aus: `last_at + min_gap_minutes` (wenn last_at) und, falls `remaining_24h === 0`,
  `älteste Einnahme im Fenster + 24 h`. Liegt das Maximum in der Vergangenheit oder gibt es keine Einnahme → `null`.
- `possible_now` = `next_possible_at === null`
- `minutes_until_possible` = Minuten bis `next_possible_at`, aufgerundet; null wenn possible_now
- `due` = `possible_now && last_at !== null && now − last_at < 36 h` (nach 36 h ohne Einnahme gilt das Mittel als
  abgesetzt, keine Erinnerung mehr; die erste Einnahme wird nie erinnert). Pausierte Medikamente: `due = false`.

Endpunkte:
- `GET /api/medications` → `200 { "now": "<ISO>", "medications": [ { id, name, dose, max_per_day, min_gap_minutes, active, sort_order, last_at, taken_24h, remaining_24h, possible_now, next_possible_at, minutes_until_possible, due } ] }`
  (alle, auch pausierte; sortiert nach sort_order, id)
- `POST /api/medications` Body `{ name, dose?, max_per_day?, min_gap_minutes? }` (Default gap 0) → `201 { "medication": {...mit Status} }`
- `PATCH /api/medications/:id` Teilmenge von `{ name, dose, max_per_day, min_gap_minutes, active, sort_order }` → `200 { "medication": {...} }`
- `DELETE /api/medications/:id` → `204` (löscht Einnahmen mit)
- `POST /api/medications/:id/intakes` Body `{ "at": "<ISO optional>", "note": "optional", "on_duplicate": "ask|force|skip" }`
  → `201 { "intake": {id, medication_id, at, note, created_at}, "medication": {...mit Status} }`.
  Doppelschutz wie bei feeds (10 min, gleiche Semantik: 409 / 200 skipped / 201). Eine Einnahme **vor** `next_possible_at`
  wird **nicht** vom Server verhindert (Mama entscheidet), der Client fragt vorher nach.
- `GET /api/med-intakes?limit=50&before=<ISO>&medication_id=<id>` → `200 { "intakes": [ { id, medication_id, name, dose, at, note, created_at } ] }`, `at` absteigend
- `GET /api/med-intakes/:id` → `200 { "intake": {id, medication_id, at, note, created_at} }`
- `PATCH /api/med-intakes/:id` Teilmenge von `{ "at": "<ISO>", "note": "..." }` → `200 { "intake": {...}, "medication": {...mit Status} }`.
  Zum Nachkorrigieren, wenn „Genommen“ erst später gedrückt wurde: `at` darf höchstens 5 min in der Zukunft liegen, `created_at` bleibt.
  Der Medikamentenstatus (`taken_24h`, `next_possible_at`, `due`, …) wird aus der neuen Zeit berechnet; kein Doppelschutz beim Verschieben.
- `DELETE /api/med-intakes/:id` → `204`
- `GET /api/export.csv?what=intakes` → CSV `id,medication,dose,at,note`, Dateiname `boobo-medikamente.csv`

Zusätzlich in `GET /api/state` (für Home Assistant, nur **aktive** Medikamente):
```json
"medications": [ { "id": 1, "name": "Paracetamol", "dose": "1 g", "taken_24h": 2, "remaining_24h": 2,
                   "possible_now": false, "next_possible_at": "2026-10-31T19:10:00.000Z", "due": false } ],
"medications_due": ["Paracetamol 1 g"]      // name + dose der aktiven Medikamente mit due = true
```

## 5. Frontend-Erweiterungen (public/), verbindliche Verhaltensregeln
- **Doppelschutz:** Antwort 409 beim Tippen → Rückfrage im Dialog „Um 14:32 schon notiert. Trotzdem eintragen?“ mit
  „Ja, trotzdem“ (→ erneut mit `on_duplicate: "force"`) und „Nein, passt“. Gilt für Stillen und Medikamente.
- **Schnellzeiten:** Im Nachtragen-Dialog eine Chip-Zeile über dem Zeitfeld: „vor 10 min · 20 min · 30 min · 45 min · 1 h“
  setzt das Zeitfeld. **Langes Drücken** (≥ 500 ms) auf Links/Rechts/Beide/Flasche öffnet Nachtragen mit vorgewählter
  Seite, ohne danach einen normalen Tipp auszulösen (kein Kontextmenü, keine Textauswahl).
- **Nachtmodus:** Einstellungen bekommen „Erscheinungsbild“ als Segment System / Hell / Dunkel (localStorage `boobo.theme`,
  gesetzt als `html[data-theme="light|dark"]`, bei System kein Attribut) und einen Schalter „Nachts dimmen (22–7 Uhr)“
  (localStorage `boobo.night`, Default an). Aktiv zwischen 22:00 und 07:00 Ortszeit (minütlich geprüft): erzwingt dunkle
  Tokens und `html.night` mit gedämpften Werten (dunklerer Hintergrund, etwas weniger Kontrast, entsättigte Seitenfarben).
  CSS: dunkle Tokens einmal unter `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` und einmal
  unter `:root[data-theme="dark"]`; `theme-color`-Meta wird per JS nachgezogen.
- **Tagesbilanz:** Karte „Letzte 24 Stunden“ über dem Verlauf: „9 Mal gestillt · längste Pause 3 h 40“ und darunter
  „Windeln: 5 nass, 2 voll“. Kein Durchschnitt auf der Startseite. Bei 0 Einträgen: Karte ausblenden.
- **Windeln:** Unter den vier Still-Buttons eine kleinere Reihe mit zwei Buttons „Nass“ und „Voll“ (56 px hoch), ein Tipp
  = `POST /api/diapers` jetzt, Toast mit Rückgängig (→ DELETE). Windeln erscheinen im Verlauf „Bisher“ chronologisch
  zwischen den Still-Einträgen (eigene Zeile mit Tropfen-Symbol, Tippen → Zeit ändern/löschen).
- **Medikamente:** Karte „Für Mama“ zwischen Windeln und Tagesbilanz, nur aktive Medikamente. Pro Zeile: Name + Dosis,
  Statuszeile, Button „Genommen“. Statustexte: noch nie → „Noch nichts genommen“; möglich → „Geht wieder · zuletzt 12:10“
  (bzw. „Geht jetzt“ wenn `due`); noch nicht → „Wieder ab 16:30 · 2 von 4“; `remaining_24h === 0` → „Für heute komplett · 4 von 4“.
  Tipp vor `next_possible_at` → Rückfrage „Eigentlich erst ab 16:30. Trotzdem notieren?“ („Ja, trotzdem“ / „Lieber warten“).
  Toast „Paracetamol, 14:32. Notiert.“ + Rückgängig (→ DELETE intake). Kleiner Link „Alle Einnahmen“ öffnet eine Liste
  (letzte 50); Tippen auf eine Zeile öffnet den Dialog „Einnahme“ (Zeitpunkt ändern → PATCH, „Löschen“). Langes Drücken
  auf „Genommen“ öffnet denselben Dialog als „Nachtragen“ mit frei wählbarer Uhrzeit (POST mit `at`, Doppelschutz wie sonst). Verwaltung in den Einstellungen: Liste aller Medikamente mit Name, Dosis, „max. pro Tag“,
  „Abstand in Stunden“ (Eingabe in Stunden, API bekommt Minuten), Pausieren-Schalter, Löschen, „Hinzufügen“.
- **Startbildschirm-Hilfe:** In den Einstellungen ein aufklappbarer Abschnitt „Als App auf den Startbildschirm“ mit
  iPhone-Schritten (Safari → Teilen → Zum Home-Bildschirm) und Android-Schritten: Chrome kann Apps ohne HTTPS nicht
  installieren; darum einmalig `chrome://flags/#unsafely-treat-insecure-origin-as-secure` öffnen, auf „Enabled“ stellen,
  `location.origin` (die App zeigt den echten Wert) ins Textfeld, Chrome neu starten, dann Menü ⋮ → „App installieren“.

---

# Erweiterung 3 (2026-11-01): HTTPS mit eigener Zertifizierungsstelle

Hintergrund: Chrome auf Android zeigt bei http in installierten Web-Apps immer die Adressleiste; echte
App-Installation (ohne Leiste, mit Service Worker/Offline-Cache) gibt es nur über HTTPS. Boobo bringt dafür
eine eigene kleine CA mit. Der http-Port 8099 bleibt unverändert (Home Assistant, Healthcheck).

## Server
- Env `HTTPS_PORT` (Default `8443`, `0` = aus), `TLS_DIR` (Default `${DATA_DIR}/tls`),
  `TLS_HOSTS` (Komma-Liste der Adressen, unter denen die App im LAN erreichbar ist, z. B. `192.168.0.124,nas.local`;
  IPs werden als `IP:`-SAN, Namen als `DNS:`-SAN eingetragen; `localhost` und `127.0.0.1` sind immer dabei).
- Beim Start, wenn `HTTPS_PORT > 0`: Dateien in `TLS_DIR` sicherstellen, erzeugt mit `openssl` (im Image installiert):
  - `ca.key` / `ca.crt`: eigene CA, CN „Boobo Zuhause CA“, EC P-256, 10 Jahre, `basicConstraints=critical,CA:TRUE`.
  - `server.key` / `server.crt`: Serverzertifikat, signiert von der CA, EC P-256, **820 Tage** (Apple akzeptiert max. 825),
    SAN mit allen `TLS_HOSTS`, `extendedKeyUsage=serverAuth`, `basicConstraints=CA:FALSE`.
  - `hosts.txt`: die Liste, für die `server.crt` ausgestellt wurde. Ändert sich `TLS_HOSTS` oder läuft das
    Serverzertifikat in < 30 Tagen ab, wird nur `server.*` neu erzeugt (CA bleibt, Handys müssen nichts neu installieren).
  - Fehlt `openssl` oder schlägt die Erzeugung fehl: Warnung ins Log, HTTPS bleibt aus, http läuft weiter.
- Zweiter Listener `https.createServer` mit demselben Request-Handler auf `0.0.0.0:HTTPS_PORT`.
- `GET /boobo-ca.crt` (auf http **und** https): PEM der CA, `Content-Type: application/x-x509-ca-cert`,
  `Content-Disposition: attachment; filename="boobo-ca.crt"`, `Cache-Control: no-store`. 404 wenn HTTPS aus.
- `GET /api/health` zusätzlich:
  ```json
  "https": { "enabled": true, "port": 8443, "hosts": ["192.168.0.124"], "ca_url": "/boobo-ca.crt",
             "ca_name": "Boobo Zuhause CA", "cert_expires_at": "2029-01-29T07:00:00.000Z" }
  ```
  bzw. `"https": { "enabled": false }`.
- `createServer()` bekommt die Optionen `httpsPort`, `tlsDir`, `tlsHosts`; Rückgabe zusätzlich `httpsServer` (oder null)
  und `https` (das Health-Objekt). `close()` schließt beide Listener.

## Docker / Compose
- Dockerfile: `apk add --no-cache openssl`, `EXPOSE 8099 8443`.
- docker-compose.yml: Port `8443:8443`, `HTTPS_PORT=8443`, `TLS_HOSTS=192.168.0.124` (die LAN-IP des NAS; im Router fest vergeben).
  Zertifikate liegen im Volume `boobo-data` unter `/data/tls` und überleben Redeploys.

## Frontend (public/)
- Einstellungen → „Als App auf den Startbildschirm“ liest `health.https`:
  - Seite läuft über **http** und `https.enabled`: Anleitung „einmalig Zertifikat installieren“ mit Download-Link
    `/boobo-ca.crt`, Android- und iPhone-Schritten, und einem Link auf `https://<location.hostname oder hosts[0]>:<port>/`.
  - Seite läuft über **https**, nicht standalone: nur „Menü ⋮ → App installieren“ (Android) bzw. „Teilen → Zum
    Home-Bildschirm“ (iPhone).
  - standalone: Abschnitt ausgeblendet. `https.enabled === false`: Hinweis auf README.
- Der Chrome-Flag-Weg entfällt aus der Anleitung.

---

# Erweiterung 4: Wachstum

Rechenmodul `lib/growth.js` (reine Funktionen), Referenzdaten `growth/who.json` und `growth/de.json`
(erzeugt mit `tools/build-growth-refs.py`, Quellen im README).

## Datenmodell
- `settings.growth_profile` (JSON): `name`, `sex` (`male` \| `female`), `birth_date` (`YYYY-MM-DD`),
  `gestation_weeks` (22..44), `gestation_days` (0..6), `birth_weight_g` (300..7000), `birth_length_cm` (25..65),
  `birth_hc_cm` (18..45), `mother_height_cm`, `father_height_cm` (120..230), `ref` (Kennung der gewählten Kurve).
  Alles optional, `null` löscht.
- Tabelle `measurements`: `id`, `date` (`YYYY-MM-DD`, Ortszeit), `weight_g` INTEGER (300..30000), `length_cm` REAL
  (25..130), `hc_cm` REAL (18..60), `source` (`nurse` \| `doctor` \| `home` \| `hospital` \| null), `note`,
  `created_at`, `updated_at`. Mindestens ein Messwert. cm auf 0,1 gerundet.
- Tabelle `growth_refs`: importierte Kurven (`id` TEXT PK, `data` JSON). Eingebaut: `who`, `de`. `dk` ist ein
  Platzhalter (`available: false`), bis eine Kurve mit der Kennung `dk` importiert ist.

## Rechnung
- Alter in Tagen = `date` − `birth_date`. Geburt vor 37+0: korrigiertes Alter (Alter − (280 − Gestationstage)) bis
  730 Tage chronologisch; Kurvenpunkte und Perzentilen nutzen dann das korrigierte Alter.
- LMS linear zwischen Tabellenzeilen interpoliert; z = ((x/M)^L − 1)/(L·S), bei |z| > 3 und L ≠ 1 WHO-Regel
  (lineare Fortsetzung über den Abstand der 2- und 3-SD-Linie). Perzentile = Φ(z) × 100.
- Die Geburtsdaten zählen als erste Messung (`id: "birth"`).
- `gains`: aufeinanderfolgende Gewichte, `g_per_day`, `g_per_week`.
- `early`: tiefstes Gewicht in den ersten 21 Tagen unter Geburtsgewicht, `loss_pct`, erster Tag mit Gewicht ≥
  Geburtsgewicht danach (`regained_day`).
- `velocity` (nur WHO): Zunahme in den WHO-Intervallen (0–4 Wochen, 4 Wochen–2 Monate, dann monatlich bis 12 Monate).
  Gewicht am Intervallende exakt, linear zwischen Messungen mit ≤ 14 Tagen Abstand oder nächste Messung ≤ 3 Tage.
  z = (((Zunahme + δ)/M)^L − 1)/(L·S) mit δ aus der WHO-Tabelle.
- `target`: Tanner (Elternmittel ± 6,5 cm, Bereich ± 8,5 cm) und, wenn die Kurve eine Erwachsenengröße hat,
  Hermanussen-Cole (0,72 × mittlerer Eltern-SDS, Bereich ± 1,6 SDS). `curves.length.target` zeichnet den Zielkanal.

## Endpunkte
### `GET /api/growth?ref=<id>&range_days=<28..1826>`
→ `200 { profile, ref, ref_requested, ref_unavailable, refs, today, sex, age_days, corrected_age_days,
correction_days, range_days, measurements, latest, gains, early, velocity, target, curves, lines }`.
`ref` fehlt → `profile.ref` → `who`. Unbekannte oder nicht importierte Kurve → WHO und `ref_unavailable`.
`range_days` fehlt → kleinster Bereich aus 91/183/365/730/1096/1826, der alle Messungen und das heutige Alter plus 21 Tage
abdeckt. `measurements[]`: Messwerte plus `age_days`, `plot_age_days`, `scores.{weight,length,hc} = { z, p, dz }`
(`dz` = Änderung zum vorigen Wert derselben Größe). `curves.<measure>.lines[] = { z, label, points: [[Tag, Wert]] }`
(Gewicht in g, sonst cm).

### `GET /api/growth/profile` → `{ profile }`; `PUT`/`PATCH /api/growth/profile`
Nur mitgeschickte Felder werden geändert. `ref` muss eine verfügbare Kurve sein. Geburtstag nicht in der Zukunft.

### `GET`/`POST /api/growth/measurements`, `GET`/`PATCH`/`DELETE /api/growth/measurements/:id`
`POST` → `201 { measurement }`. `PATCH` mit mindestens einem Feld; leerer Messwert-Satz → 400.

### `GET /api/growth/refs` → `{ refs: [{ id, name, title, kind, description, source, builtin, available, measures,
max_age_days, has_velocity, has_adult_height }] }`
### `POST /api/growth/refs` (Body bis 4 MB)
`{ id?: "dk" | "<a-z0-9->", name?, csv?: "<Text>", data?: <Referenz-JSON>, age_unit?: days|weeks|months|years,
measure?: weight|length|hc, sex?: male|female, replace?: false }` → `201 { ref }`.
CSV: Spalten Messgröße, Geschlecht, Alter (Kopfzeile bestimmt die Einheit: `age_days`, `age_weeks`, `age_months`,
`age_years`, `alter`, `alder_mdr` …), `L`/`nu`, `M`/`mu`, `S`/`sigma`. Trenner Komma, Semikolon oder Tab; bei
Semikolon Dezimalkomma. `measure`/`sex` im Body gelten für Zeilen ohne diese Spalten. Gewicht in kg (Werte > 100 bei
Alter 0 werden als Gramm erkannt). Gleiche Kennung ergänzt die vorhandene Kurve (`replace: true` ersetzt).
Ohne `id` → `eigene-1`, `eigene-2` … `who`/`de` → 400. Reicht die Längenkurve bis ≥ 18 Jahre, dient der letzte Wert
als Erwachsenengröße für die Zielgröße.
### `GET /api/growth/refs/:id` → `{ ref }` (vollständig); `DELETE /api/growth/refs/:id` → 204 (eingebaute → 400).
Ist die gelöschte Kurve im Profil gewählt, wird `profile.ref` auf `null` gesetzt.

### `GET /api/state` zusätzlich
`growth: null` (ohne Geburtstag) oder `{ ref, age_days, corrected_age_days, weight_g, weight_date, weight_percentile,
length_cm, length_percentile, hc_cm, hc_percentile, gain_g_per_week }`.

### `GET /api/export.csv?what=measurements` → `boobo-wachstum.csv` (`id,date,weight_g,length_cm,hc_cm,source,note`).

## Frontend
- Startseite: Karte „Wachstum“ unter der Tagesbilanz. Ohne Geburtstag: „Geburtsdaten eintragen“. Sonst letztes Gewicht
  mit Perzentile, Länge und Kopf, Alter, Zunahme pro Woche, Button „Messung eintragen“, Link „Kurven“.
- Dialog „Wachstum“: Kurvenwahl (WHO, Deutschland, Dänemark, eigene; nicht importierte gestrichelt, Tipp öffnet den
  Import), Gewicht/Länge/Kopf, SVG-Diagramm mit Perzentilen-Linien, Fläche zwischen äußerster Linie, Messpunkten,
  Linie für heute und gestricheltem Zielkanal, Zeitraum 3 Monate bis 5 Jahre, Abschnitte Zunahme, Zielgröße, Messungen.
- Dialoge „Messung“, „Geburtsdaten“ (auch über Einstellungen), „Kurve importieren“ (Datei oder eingefügte Tabelle).
