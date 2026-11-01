# Boobo

Boobo ist ein minimaler Still-Tracker für zwei Eltern: ein Tipp auf **Links**, **Rechts**, **Beide** oder
**Flasche** – fertig. Läuft als ein kleiner Docker-Container auf dem NAS im Heimnetz, ohne Accounts,
ohne Cloud, ohne Abhängigkeiten.

## Features

- Große Statusanzeige: wann zuletzt, welche Seite, wie lange her – Fortschrittsanzeige bis zur
  nächsten Mahlzeit, wird deutlich, wenn Bobo bestimmt schon Hunger hat
- Vorschlag für die nächste Seite
- Vier große Buttons, Ein-Tipp-Erfassung mit „Rückgängig“
- Doppelschutz: Tippen beide Eltern fast gleichzeitig (oder zweimal), fragt Boobo nach
  („Um 14:32 schon notiert. Trotzdem eintragen?“), statt doppelt zu speichern
- Nachtragen mit manueller Uhrzeit und Schnellzeiten („vor 10 min“ bis „1 h“); langes Drücken auf einen
  Seiten-Button öffnet Nachtragen direkt mit dieser Seite. Einträge ändern und löschen
- Windeln: „Nass“ und „Voll“ mit einem Tipp, im Verlauf zwischen den Mahlzeiten
- Tagesbilanz „Letzte 24 Stunden“: wie oft gestillt, längste Pause, Windeln
- Medikamente für Mama: Paracetamol, Ibuprofen & Co. mit Mindestabstand und Tageshöchstzahl, „Wieder ab 16:30“
  auf einen Blick, Erinnerung per Home Assistant
- Nachtmodus: Erscheinungsbild System/Hell/Dunkel und automatisches Dimmen zwischen 22 und 7 Uhr
- Verlauf nach Tagen gruppiert, mit Abständen zwischen den Mahlzeiten
- Beide Handys synchron (automatische Aktualisierung alle 30 s)
- Dunkles, nachttaugliches Design, als PWA auf den Home-Bildschirm legbar
- Einstellbares Intervall (Standard 3 h), CSV-Export
- JSON-API für Home Assistant inkl. fertiger Sensoren, Erinnerungs-Automation und Notieren per Taster/Fernbedienung
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
Container `boobo` auf Port **8099** (HTTP) und **8443** (HTTPS), mit Healthcheck und automatischem Neustart.

### Feste Container-IP

Die Compose-Datei legt ein eigenes Bridge-Netz `boobo-net` mit dem Subnetz `172.22.10.0/24` an und gibt dem
Container die feste Adresse **`172.22.10.10`**. So bleibt die interne IP über Neustarts und Redeploys gleich,
und Portainer vergibt kein zufälliges Subnetz. Im Heimnetz erreichst du die App trotzdem über `http://NAS-IP:8099`
(Port-Mapping); die feste IP ist für andere Container auf demselben NAS gedacht, etwa Home Assistant im Docker.

Falls `172.22.10.x` bei dir doch belegt ist: in `docker-compose.yml` unter `networks:` Subnetz und Gateway
sowie beim Service `ipv4_address` anpassen (alle drei im selben Bereich), dann den Stack neu deployen.
Fehlermeldung „Pool overlaps with other one on this address space“ bedeutet genau das.

Alternativ per Kommandozeile auf dem NAS:

```bash
git clone https://github.com/killlian24/boobo && cd boobo
docker compose up -d --build
```

### App öffnen und auf den Startbildschirm legen

Im Heimnetz: **`http://NAS-IP:8099`** (IP des NAS einsetzen, z. B. `http://192.168.0.124:8099`). Zum Ausprobieren und für
Home Assistant reicht das. Als „echte“ App (ohne Adressleiste, mit Offline-Cache) läuft Boobo über **`https://NAS-IP:8443`**.

**Warum HTTPS?** Chrome auf Android zeigt bei `http` in installierten Apps immer die Adressleiste und bietet nur
„Verknüpfung erstellen“ an. iOS ist da gnädiger, aber auch dort bringt erst HTTPS den Offline-Cache (Service Worker
brauchen einen sicheren Kontext).

**So funktioniert es:** Boobo erzeugt beim ersten Start eine eigene kleine Zertifizierungsstelle („Boobo Zuhause CA“) und
daraus ein Zertifikat für die NAS-Adresse. Die Dateien liegen im Volume unter `/data/tls` und überleben Redeploys. Auf jedem
Handy muss die CA **einmalig** installiert werden; danach vertraut das Handy Boobo im Heimnetz.

Voraussetzungen:

- In `docker-compose.yml` muss `TLS_HOSTS` die **LAN-IP des NAS** enthalten (z. B. `TLS_HOSTS=192.168.0.124`, mehrere
  Adressen mit Komma). Ändert sich die Liste, stellt Boobo nur das Serverzertifikat neu aus; die Handys müssen nichts neu
  installieren.
- Im Router dem NAS eine **feste IP** zuweisen, sonst passt das Zertifikat nach einem Wechsel nicht mehr.
- Port **8443** muss erreichbar sein (steht in der Compose-Datei bereits mit drin).

**Schritt 1, auf beiden Systemen:** Auf dem Handy `http://NAS-IP:8099/boobo-ca.crt` öffnen (in der App geht das einfacher:
Einstellungen → „Als App auf den Startbildschirm“ → „Zertifikat laden“).

**Schritt 2, Android (Samsung):** Einstellungen → **„Sicherheit und Datenschutz“** → **„Weitere Sicherheitseinstellungen“** →
**„Von Gerätespeicher installieren“** → **„CA-Zertifikat“** → **„Trotzdem installieren“** → Datei `boobo-ca.crt` aus den
Downloads wählen.

**Schritt 2, Android (andere):** Einstellungen → **„Sicherheit“** → **„Verschlüsselung & Anmeldedaten“** →
**„Zertifikat installieren“** → **„CA-Zertifikat“** → Datei `boobo-ca.crt` wählen.

Android kann nach dem Installieren eines Nutzer-Zertifikats einen Sicherheitshinweis anzeigen („Das Netzwerk wird
möglicherweise überwacht“ o. ä.). Das ist normal: Das Zertifikat gilt nur für die Adresse deines NAS und für nichts anderes
im Internet.

**Schritt 2, iPhone:** Die Adresse aus Schritt 1 in **Safari** öffnen und **„Erlauben“** tippen. Dann Einstellungen → ganz oben
**„Profil geladen“** → **Installieren**. Danach Einstellungen → Allgemein → Info → **„Zertifikatsvertrauenseinstellungen“** →
**„Boobo Zuhause CA“** einschalten.

**Schritt 3:** `https://NAS-IP:8443` öffnen (z. B. `https://192.168.0.124:8443`).

- **Android (Chrome):** Menü (⋮) → **„App installieren“**.
- **iPhone (Safari):** Teilen-Symbol → **„Zum Home-Bildschirm“** → Hinzufügen.

Die App zeigt diese Anleitung auch selbst: Einstellungen → „Als App auf den Startbildschirm“, mit dem richtigen Link.

Eine alte Verknüpfung (http) kann gelöscht werden. Wer früher den Chrome-Schalter
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` gesetzt hat, kann ihn wieder auf **„Default“** stellen; er wird
nicht mehr gebraucht.

Wer Boobo lieber hinter einem eigenen HTTPS-Reverse-Proxy (z. B. Nginx Proxy Manager oder Caddy) oder per Tailscale
betreibt, kann den eingebauten HTTPS-Port mit `HTTPS_PORT=0` abschalten.

## Home Assistant

Boobo liefert unter `GET /api/state` den aktuellen Stand als JSON. Im Ordner [`homeassistant/`](homeassistant/)
liegen fertige REST-Sensoren, Template-Entitäten, eine Automation „Bobo hat bald Hunger“ (Benachrichtigung an beide
Handys nach 3 h), eine Erinnerung „Kurz an dich denken“ für Mamas Medikamente, Skripte zum Notieren
(Stillen, Windeln, Medikamente) und eine Dashboard-Karte. Schritt-für-Schritt-Anleitung: [`homeassistant/README.md`](homeassistant/README.md).

## Konfiguration

Umgebungsvariablen (in `docker-compose.yml` unter `environment:` setzen):

| Variable | Default | Bedeutung |
|---|---|---|
| `PORT` | `8099` | HTTP-Port im Container |
| `HTTPS_PORT` | `8443` | HTTPS-Port im Container (eigene CA, siehe oben); `0` schaltet HTTPS ab |
| `TLS_DIR` | `${DATA_DIR}/tls` (`/data/tls`) | Ablageort von CA und Serverzertifikat |
| `TLS_HOSTS` | – | Komma-Liste der LAN-Adressen des NAS, für die das Zertifikat gilt (z. B. `192.168.0.124,nas.local`); `localhost` und `127.0.0.1` sind immer dabei |
| `DATA_DIR` | `/data` (Image) / `./data` (lokal) | Ablageort der SQLite-Datei `boobo.db` |
| `FEED_INTERVAL_MINUTES` | `180` | Stillintervall in Minuten beim **ersten Start**; danach gilt der Wert aus den App-Einstellungen |
| `FEED_DUPLICATE_MINUTES` | `10` | Zeitfenster des Doppelschutzes in Minuten |
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
| `GET`/`POST` | `/api/diapers` | Windeln lesen / eintragen (`kind`: `wet` \| `dirty`) |
| `PATCH`/`DELETE` | `/api/diapers/:id` | Windel ändern / löschen |
| `GET`/`POST` | `/api/medications` | Medikamente mit Status lesen / anlegen |
| `PATCH`/`DELETE` | `/api/medications/:id` | Medikament ändern (z. B. pausieren) / löschen |
| `POST` | `/api/medications/:id/intakes` | Einnahme notieren |
| `GET` | `/api/med-intakes` | Einnahmen lesen |
| `DELETE` | `/api/med-intakes/:id` | Einnahme löschen |
| `GET`/`PUT` | `/api/settings` | Intervall lesen / setzen |
| `GET` | `/api/export.csv` | CSV-Export (`?what=diapers` oder `?what=intakes` für Windeln bzw. Medikamente) |

Neu in `GET /api/state`: `summary_24h` (Tagesbilanz), `medications` und `medications_due`. `POST /api/feeds` und
`POST /api/medications/:id/intakes` kennen `on_duplicate` (`ask`, `force`, `skip`): Liegt schon ein Eintrag weniger als
10 Minuten entfernt (`FEED_DUPLICATE_MINUTES`), antwortet der Server bei `ask` mit `409`, bei `skip` mit
`200 { "skipped": true, "existing": … }`, bei `force` speichert er trotzdem. Details in
[`docs/API.md`](docs/API.md) („Erweiterung 2“).

## Lizenz

[MIT](LICENSE) – © 2026 Kilian vom Stein
