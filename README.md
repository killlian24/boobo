# Boobo

Boobo ist ein minimaler Still-Tracker für zwei Eltern: ein Tipp auf **Links**, **Rechts**, **Beide** oder
**Flasche** – fertig. Läuft als ein kleiner Docker-Container auf dem NAS im Heimnetz, ohne Accounts,
ohne Cloud, ohne Abhängigkeiten.

## Features

- Große Statusanzeige: wann zuletzt, welche Seite, wie lange her – Fortschrittsanzeige bis zur nächsten
  nächsten Mahlzeit, wird deutlich, wenn Bobo bestimmt schon Hunger hat
- Vorschlag für die nächste Seite
- Vier große Buttons, Ein-Tipp-Erfassung mit „Rückgängig“
- Nachtragen mit manueller Uhrzeit, Einträge ändern und löschen
- Verlauf nach Tagen gruppiert, mit Abständen zwischen den Mahlzeiten
- Beide Handys synchron (automatische Aktualisierung alle 30 s)
- Dunkles, nachttaugliches Design, als PWA auf den Home-Bildschirm legbar
- Einstellbares Intervall (Standard 3 h), CSV-Export
- JSON-API für Home Assistant inkl. fertiger Sensoren und Erinnerungs-Automation
- Node.js 24 + SQLite (`node:sqlite`), **keine npm-Pakete**, eine Datei `server.js`

## Installation über Portainer (empfohlen)

Portainer klont das Repository und baut das Image direkt auf dem NAS – kein Image-Registry nötig.

1. Portainer öffnen → **Stacks** → **Add stack**
2. **Name:** `boobo`
3. **Build method:** **Repository**
4. **Repository URL:** `https://github.com/killlian24/boobo`
5. **Repository reference:** `refs/heads/main`
6. **Compose path:** `docker-compose.yml`
7. Optional: **GitOps updates** aktivieren (z. B. Polling alle 24 h), dann zieht Portainer neue Versionen
   automatisch. Sonst später im Stack den Button **„Pull and redeploy“** benutzen.
8. **Deploy the stack**

Der erste Build dauert je nach NAS etwa 1–3 Minuten (Node-Image laden, Dateien kopieren). Danach läuft der
Container `boobo` auf Port **8099**, mit Healthcheck und automatischem Neustart.

Alternativ per Kommandozeile auf dem NAS:

```bash
git clone https://github.com/killlian24/boobo && cd boobo
docker compose up -d --build
```

### App öffnen und auf den Home-Bildschirm legen

Im Heimnetz: **`http://NAS-IP:8099`** (IP des NAS einsetzen, z. B. `http://192.168.1.20:8099`).
Tipp: dem NAS im Router eine feste IP geben.

- **iPhone (Safari):** Seite öffnen → Teilen-Symbol → **„Zum Home-Bildschirm“** → Hinzufügen
- **Android (Chrome):** Seite öffnen → Menü (⋮) → **„Zum Startbildschirm hinzufügen“** bzw. **„App installieren“**

Boobo läuft bewusst nur per HTTP im LAN (kein HTTPS, kein Reverse Proxy). Dadurch gibt es keinen
Offline-Cache (Service Worker brauchen HTTPS) – alles andere, inklusive Vollbild-Icon auf dem
Home-Bildschirm, funktioniert.

## Home Assistant

Boobo liefert unter `GET /api/state` den aktuellen Stand als JSON. Im Ordner [`homeassistant/`](homeassistant/)
liegen fertige REST-Sensoren, Template-Entitäten, eine Automation „Bobo hat bald Hunger“ (Benachrichtigung an beide
Handys nach 3 h) und eine Dashboard-Karte. Schritt-für-Schritt-Anleitung: [`homeassistant/README.md`](homeassistant/README.md).

## Konfiguration

Umgebungsvariablen (in `docker-compose.yml` unter `environment:` setzen):

| Variable | Default | Bedeutung |
|---|---|---|
| `PORT` | `8099` | HTTP-Port im Container |
| `DATA_DIR` | `/data` (Image) / `./data` (lokal) | Ablageort der SQLite-Datei `boobo.db` |
| `FEED_INTERVAL_MINUTES` | `180` | Stillintervall in Minuten beim **ersten Start**; danach gilt der Wert aus den App-Einstellungen |
| `TZ` | `Europe/Berlin` | Zeitzone für Logging und den Tageszähler („heute“) |

Alle Zeiten in der API sind ISO-8601 in UTC; die Oberfläche zeigt lokale Zeit.

## Daten & Backup

- Alle Daten liegen in **einer SQLite-Datei** `boobo.db` im Volume `boobo-data` (Mountpunkt `/data`).
  Für einen Bind-Mount auf dem NAS (z. B. `/volume1/docker/boobo:/data`) siehe Kommentar in
  `docker-compose.yml`; der Ordner muss uid 1000 gehören (`chown -R 1000:1000`).
- **CSV-Export:** `http://NAS-IP:8099/api/export.csv` (auch über die Einstellungen in der App erreichbar).
- **Backup:** Volume sichern oder einfach die Datei kopieren, z. B.
  `docker cp boobo:/data/boobo.db ./boobo-backup.db`. Beim Zurückspielen den Container vorher stoppen.

## Lokale Entwicklung

Voraussetzung: Node.js ≥ 22.13 (empfohlen 24). Keine Installation nötig.

```bash
node server.js        # startet auf http://localhost:8099, Daten in ./data
npm test              # führt die Tests in test/ aus (node --test)
```

Docker lokal: `docker compose up --build`.

## API

Alle Endpunkte, das Datenmodell und das Verhalten des Frontends sind in [`docs/API.md`](docs/API.md)
beschrieben. Kurzüberblick:

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/health` | Lebenszeichen |
| `GET` | `/api/state` | Aktueller Stand (für Startseite und Home Assistant) |
| `GET`/`POST` | `/api/feeds` | Verlauf lesen / Stillen eintragen |
| `PATCH`/`DELETE` | `/api/feeds/:id` | Eintrag ändern / löschen |
| `GET`/`PUT` | `/api/settings` | Intervall lesen / setzen |
| `GET` | `/api/export.csv` | CSV-Export |

## Lizenz

[MIT](LICENSE) – © 2026 Kilian vom Stein
