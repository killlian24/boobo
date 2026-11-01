# Boobo – Tonalität und Texte

Grundsatz: Es gibt keine „Fälligkeit“ und keine „Überfälligkeit“. Es gibt ein Baby, das bald Hunger
hat, und zwei Eltern, die es gut machen. Keine Technik-Wörter (Intervall, Timer, Eintrag, Status),
keine Vorwürfe, keine Alarmstimmung. Warm, kurz, ein kleines Augenzwinkern ist erlaubt.

| Stelle | Vorher | Jetzt |
|---|---|---|
| Letztes Stillen | „Zuletzt: 14:32 · Links · vor 1 h 12 min“ | „Zuletzt um 14:32 · Links · vor 1 h 12 min“ |
| Nächste Mahlzeit | „Nächste fällig um 17:32“ | „Bobo meldet sich wohl gegen 17:32“ |
| Noch viel Zeit (< 50 %) | – | Untertitel: „Noch Zeit zum Kuscheln“ |
| Bald (≥ 80 %) | – | Untertitel: „Bobo wird langsam hungrig“ |
| Zeit ist um | „Überfällig seit 12 min“ | „Bobo hat bestimmt Hunger · seit 12 min“ |
| Seitenvorschlag | „Als Nächstes: Rechts“ | „Diesmal ist Rechts dran“ |
| Buttons | Links / Rechts / Beide / Flasche | unverändert |
| Toast nach Tipp | „Links eingetragen · 14:32“ | „Links, 14:32. Notiert.“ + zweite Zeile „Ihr macht das toll.“ |
| Rückgängig | „Rückgängig“ | „Rückgängig“ |
| Rückgängig bestätigt | – | „Weg damit, nichts passiert.“ |
| Leerer Zustand | „Noch kein Eintrag“ | „Noch nichts notiert. Beim ersten Stillen einfach auf eine Seite tippen.“ Verlauf: „Hier sammelt sich, was war. Bobo gibt den Takt vor.“ |
| Nachtragen | „Nachtragen“ | „Nachtragen“ |
| Verlauf-Überschrift | „Verlauf“ | „Bisher“ |
| Abstand in der Liste | „+2 h 50“ | „2 h 50 später“ |
| Einstellungen: Intervall | „Intervall (Minuten)“ | „Abstand zwischen den Mahlzeiten“ (Minuten) |
| Einstellungen Untertitel | – | „Für Bobo. Und für zwei müde, großartige Eltern.“ |
| Keine Verbindung | „Keine Verbindung zum NAS“ | „Gerade keine Verbindung zum Zuhause-Server. Ich versuche es weiter.“ |
| HA Benachrichtigung Titel | „Stillen fällig“ | „Bobo hat bald Hunger“ |
| HA Benachrichtigung Text | „Zuletzt … vor … min. Vorschlag: …“ | „Zuletzt Links, vor 3 h 5 min. Diesmal ist Rechts dran.“ |
| HA Wiederholung | – | „Bobo wartet noch – zuletzt vor 3 h 35 min.“ |
| HA Binary-Sensor Name | „Boobo überfällig“ | „Boobo: Bobo hat Hunger“ (Entity-ID `binary_sensor.boobo_bobo_hat_hunger`) |

## Erweiterung 2: Windeln, Tagesbilanz, Medikamente, Doppelschutz

| Stelle | Text |
|---|---|
| Doppelschutz Rückfrage | „Um 14:32 schon notiert. Trotzdem eintragen?“ · Buttons „Ja, trotzdem“ / „Nein, passt“ |
| HA bei Doppel (skip) | „Schon notiert, um 14:32.“ |
| Windel-Buttons | „Nass“ / „Voll“ |
| Windel-Toast | „Nass, 14:32. Notiert.“ zweite Zeile „Alles im Fluss.“ · „Voll, 14:32. Notiert.“ zweite Zeile „Volle Leistung, Bobo.“ |
| Windel im Verlauf | „Windel · nass“ / „Windel · voll“ |
| Tagesbilanz Titel | „Letzte 24 Stunden“ |
| Tagesbilanz Zeilen | „9 Mal gestillt · längste Pause 3 h 40“ / „Windeln: 5 nass, 2 voll“ |
| Medikamente Titel | „Für Mama“ |
| Medikament Status | „Noch nichts genommen“ · „Geht jetzt · zuletzt 12:10“ · „Geht wieder · zuletzt 12:10“ · „Wieder ab 16:30 · 2 von 4“ · „Für heute komplett · 4 von 4“ |
| Medikament Button | „Genommen“ |
| Zu früh Rückfrage | „Eigentlich erst ab 16:30. Trotzdem notieren?“ · „Ja, trotzdem“ / „Lieber warten“ |
| Medikament Toast | „Paracetamol, 14:32. Notiert.“ zweite Zeile „Gut auf dich aufgepasst.“ |
| HA Erinnerung Medikament | Titel „Kurz an dich denken“ · Text „Paracetamol 1 g geht wieder. Zuletzt um 12:10.“ |
| Erscheinungsbild | „Erscheinungsbild“ · System / Hell / Dunkel · „Nachts dimmen (22–7 Uhr)“ |
| Nachtragen Chips | „vor 10 min“ „20 min“ „30 min“ „45 min“ „1 h“ |
| Startbildschirm-Hilfe | „Als App auf den Startbildschirm“ · bei http: „Als echte App installieren (einmalig)“, Buttons „Zertifikat laden“ / „Boobo verschlüsselt öffnen“ |

### Ergänzungen Frontend (Erweiterung 2)

| Stelle | Text |
|---|---|
| Doppelschutz ohne Uhrzeit (Fallback) | „Gerade eben schon notiert.“ · „Trotzdem eintragen?“ |
| Uhrzeit an einem anderen Tag | Präfix „gestern “ / „morgen “, z. B. „Wieder ab morgen 02:44 · 1 von 4“, „Eigentlich erst ab morgen 02:44.“ |
| Verlauf Tageskopf | „7 Mal · 2 Windeln“ (Windeln nur wenn vorhanden, „1 Windel“) |
| Windel bearbeiten | Titel „Windel“ · Feld „Wie war sie?“ · Nass / Voll · Rückfrage „Windel löschen?“ („Ja, löschen“ / „Behalten“) |
| Alle Einnahmen | Titel „Alle Einnahmen“ · leer: „Hier stehen später Mamas Einnahmen.“ · Zeile antippen öffnet „Einnahme“ |
| Einnahme bearbeiten | Titel „Einnahme“ · Unterzeile „Paracetamol 1 g“ · Feld „Zeitpunkt“ · „Abbrechen“ / „Speichern“ · „Löschen“ → Rückfrage „Einnahme löschen?“ + „Paracetamol 1 g, 14:32“ („Ja, löschen“ / „Behalten“) |
| Einnahme nachtragen (lang auf „Genommen“) | Titel „Nachtragen“ · Unterzeile „Paracetamol 1 g“ · Button „Notieren“ · Toast „Paracetamol, gestern 23:10. Notiert.“ |
| Medikamente verwalten | Abschnitt „Für Mama“ · Zeile „max. 4 pro Tag · Abstand 6 h“ (bzw. „ohne Vorgaben“, „· pausiert“) · Schalter „Pause“ · Button „Hinzufügen“ |
| Medikament-Dialog | Titel „Hinzufügen“ / „Bearbeiten“ · Felder „Name“, „Dosis (optional)“, „max. pro Tag“ (leer = ohne), „Abstand in Stunden“ · Hinweis „Frühestens alle 6 h, höchstens 4× in 24 Stunden.“ |
| Medikament angelegt | „Eisen ist dabei.“ |
| Medikament löschen | „Paracetamol löschen?“ · „Die notierten Einnahmen verschwinden mit.“ · „Ja, löschen“ / „Behalten“ |
| Export | „Windeln als CSV“ · „Medikamente als CSV“ |
| Startbildschirm-Hilfe | Buttons „Zertifikat laden“ und „Boobo verschlüsselt öffnen“ (kein Kopieren mehr nötig) |

## Erweiterung 4: Statistik

| Stelle | Text |
|---|---|
| Kopfzeile / Karte | Icon-Button „Statistik“ · Link „Statistik“ in „Letzte 24 Stunden“ |
| Titel | „Bobos Takt“ |
| Zeitraum | „7 Tage“ / „14 Tage“ / „30 Tage“ |
| Kennzahlen | „Pro Tag“ (8,2 · „Ø über 13 volle Tage“ / „noch kein voller Tag“) · „Abstand“ (2 h 57 · „im Mittel · meist 2 h 54“) · „Nachts“ (2,8 · „pro Nacht, 22–7 Uhr“) · „Längste Pause“ (4 h 48 · „bis gestern 09:14“) |
| Abschnitte | „Wie oft pro Tag“ („Heller Balken: heute, noch nicht vorbei.“) · „Zu welcher Zeit“ („Am häufigsten zwischen 11 und 12 Uhr. Grau hinterlegt: die Nacht.“) · „Das Muster“ („Jede Zeile ein Tag, jedes Feld eine Stunde. Dunkel: da kam Bobo.“) · „Welche Seite“ („112 Mal in 14 Tagen, davon 10 Flasche · Links 51 %, Rechts 49 % (ohne Beide)“) · „Wie lange dazwischen“ („112 Abstände · kürzester 1 h 50“) · „Alle Tage als Tabelle“ |
| Hinweis unter Diagramm | „Tag antippen für Einzelheiten“ / „Stunde antippen für Einzelheiten“ / „Feld antippen für Einzelheiten“ · nach Tipp z. B. „Di., 28. Okt.: 9 Mal gestillt, davon 2 Flasche · Ø Abstand 2 h 42 · 3 nachts · 6 Windeln“, „3–4 Uhr: 5 Mal in 14 Tagen“, „Gestern, 6–7 Uhr: 1 Mal“ |
| Abstands-Klassen | „unter 1 h“ / „1 bis 2 h“ / „2 bis 3 h“ / „3 bis 4 h“ / „über 4 h“ |
| Leer | „Noch nichts zu sehen. Nach ein paar Tagen zeigt sich hier, wann Bobo kommt.“ |
