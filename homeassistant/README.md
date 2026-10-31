# Boobo in Home Assistant

Boobo stellt unter `GET http://NAS-IP:8099/api/state` ein JSON mit dem aktuellen Stand bereit
(siehe `docs/API.md`). Home Assistant liest es alle 60 s per REST-Sensor und schickt eine
Benachrichtigung an beide Handys, wenn das Intervall (Standard 3 h) überschritten ist.

Dateien in diesem Ordner:

| Datei | Zweck |
|---|---|
| `rest_sensors.yaml` | REST-Sensoren (ein Abruf, mehrere Sensoren) |
| `template.yaml` | `binary_sensor.boobo_ueberfaellig`, Vorschlag-Seite, Tageszähler |
| `automation_erinnerung.yaml` | Automation „Boobo: Bobo hat bald Hunger“ (einmalige Benachrichtigung) |
| `automation_wiederholung.yaml` | optional: alle 30 min sanft erinnern, solange Bobo noch wartet |
| `lovelace_card.yaml` | Beispiel-Karte fürs Dashboard |


> **Tipp zur Adresse:** Läuft Home Assistant als Container auf demselben NAS, kannst du statt `NAS-IP:8099`
> auch die feste Container-IP `172.22.10.10:8099` verwenden (siehe `docker-compose.yml`). Dafür muss der
> HA-Container das Netz `boobo-net` erreichen können; am einfachsten bleibt meist trotzdem `NAS-IP:8099`.

## 1. NAS-IP eintragen

In allen Dateien steht der Platzhalter `NAS-IP`. Ersetze ihn durch die IP des NAS, z. B. `192.168.1.20`.
Am einfachsten per Suchen & Ersetzen im Editor. Die IP des NAS sollte im Router fest vergeben sein
(DHCP-Reservierung), sonst ändert sie sich irgendwann.

Schnelltest im Browser: `http://192.168.1.20:8099/api/state` muss JSON liefern.

## 2. Sensoren einbinden (`rest:` und `template:`)

Kopiere `rest_sensors.yaml` und `template.yaml` in dein Home-Assistant-Konfigurationsverzeichnis
(dort, wo `configuration.yaml` liegt), z. B. in einen Unterordner `boobo/`. Dann in `configuration.yaml`:

```yaml
rest: !include boobo/rest_sensors.yaml
template: !include boobo/template.yaml
```

Falls du schon einen `rest:`- oder `template:`-Block hast, gibt es zwei Möglichkeiten:

- `!include_dir_merge_list` verwenden, z. B. `rest: !include_dir_merge_list rest/` und die Datei in diesen
  Ordner legen, oder
- den Inhalt der Datei (die Liste beginnt mit `- resource:` bzw. `- binary_sensor:`) unter deinen
  bestehenden Block hängen und die Einrückung anpassen.

Danach: **Entwicklerwerkzeuge → YAML → Konfiguration prüfen**, anschließend
**„Alle YAML-Konfigurationen neu laden“** (oder gezielt „REST-Entitäten und Benachrichtigungen“ sowie
„Template-Entitäten“). Nach spätestens 60 s sollten diese Entitäten existieren:

- `sensor.boobo_status` (Text: `ok` / `Bobo hat Hunger` / `keine Daten`, alle Rohwerte als Attribute)
- `sensor.boobo_minuten_seit_stillen` (min)
- `sensor.boobo_letzte_seite` (Links / Rechts / Beide / Flasche / –)
- `sensor.boobo_letztes_stillen` (Zeitstempel)
- `sensor.boobo_naechste_faellig` (Zeitstempel)
- `sensor.boobo_ueberfaellig_text` (Ja / Nein)
- `binary_sensor.boobo_ueberfaellig` (on / off)
- `sensor.boobo_vorschlag_seite`, `sensor.boobo_heute_anzahl`, `sensor.boobo_letzte_24h`

Prüfen unter **Entwicklerwerkzeuge → Zustände**, Filter `boobo`.

Hinweis: Solange noch kein Eintrag in Boobo existiert (`last` ist `null`), sind die zeitbezogenen
Sensoren `unavailable` – das ist Absicht und verschwindet nach dem ersten Stillen.

## 3. Notify-Dienste der Handys finden

Beide Eltern brauchen die Home-Assistant-Companion-App (iOS/Android) mit aktivierten Benachrichtigungen.
Jedes Handy legt einen eigenen Dienst an:

1. **Entwicklerwerkzeuge → Aktionen**
2. Im Feld „Aktion“ `notify.mobile_app` eintippen – es erscheinen z. B.
   `notify.mobile_app_iphone_von_anna` und `notify.mobile_app_pixel_von_ben`.
3. Dort kannst du mit „Aktion ausführen“ auch gleich eine Testnachricht schicken (Feld `message`).

Tipp für beide Handys mit einem Aufruf: eine Notify-Gruppe anlegen in `configuration.yaml`:

```yaml
notify:
  - platform: group
    name: eltern
    services:
      - action: mobile_app_iphone_von_anna
      - action: mobile_app_pixel_von_ben
```

Dann in der Automation `notify.eltern` verwenden.

## 4. Automation anlegen

1. **Einstellungen → Automatisierungen & Szenen → Automatisierung erstellen → Neue Automatisierung**
2. Oben rechts Menü (⋮) → **„In YAML bearbeiten“**
3. Inhalt von `automation_erinnerung.yaml` einfügen (Kommentare dürfen bleiben)
4. `notify.notify` durch `notify.mobile_app_<handy1>` ersetzen (für das zweite Handy den auskommentierten
   Block aktivieren oder die Notify-Gruppe aus Schritt 3 verwenden)
5. **Speichern**

Die Automation löst aus, wenn `binary_sensor.boobo_ueberfaellig` eine Minute lang `on` ist. Sobald in
Boobo ein neues Stillen eingetragen wird, geht der Sensor auf `off` und die Erinnerung ist beim nächsten
Überschreiten wieder „scharf“.

Optional:

- **Wiederholung alle 30 min**: `automation_wiederholung.yaml` genauso als zweite Automation anlegen.
- **Nachtruhe**: in der Automation unter `conditions:` eine `condition: time` mit `after`/`before` ergänzen
  (Beispiel steht als Kommentar in der Datei).
- Die Benachrichtigung hat den Button „Boobo öffnen“ (öffnet `http://NAS-IP:8099`) und nutzt den
  `tag: boobo-due`, damit wiederholte Meldungen die alte ersetzen statt sich zu stapeln.

## 5. Dashboard-Karte (optional)

Dashboard → Bearbeiten → „Karte hinzufügen“ → „Manuell“ → Inhalt von `lovelace_card.yaml` einfügen.
Die Karte zeigt letztes Stillen (relativ), Seite, Minuten, voraussichtliche nächste Mahlzeit, Seitenvorschlag, Tageszähler und
einen Button zur App.

## Fehlersuche

- **Sensoren bleiben `unavailable`/`unknown`**: Läuft der Container? `http://NAS-IP:8099/api/health`
  im Browser prüfen. HA-Log unter Einstellungen → System → Protokolle nach `rest` filtern.
- **Keine Benachrichtigung**: Automation unter Einstellungen → Automatisierungen öffnen → „Ablaufverfolgung“
  ansehen. Prüfen, ob der Dienstname stimmt und das Handy Benachrichtigungen von der Companion-App erlaubt.
- **Zeiten verschoben**: Boobo liefert UTC-Zeitstempel (`…Z`), Home Assistant rechnet selbst in die
  lokale Zeitzone um. Die Zeitzone in HA (Einstellungen → System → Allgemein) muss stimmen.
