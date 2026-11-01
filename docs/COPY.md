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

## Erweiterung 4: Wachstum

| Stelle | Text |
|---|---|
| Tabs | „Stillen“ / „Wachstum“ |
| Seite Titel | „Wachstum · Bobo“ / „4 Wochen, 2 Tage alt“ · Buttons „Messung eintragen“ / „Geburtsdaten“ |
| Seite leer | „Geburtsdaten eintragen, dann rechnet Boobo die Perzentilen.“ / „Geschlecht, Geburtstag, Maße bei Geburt und eure Größen. Alles lässt sich später ändern.“ · Button „Geburtsdaten eintragen“ |
| Messung Toast | „4.200 g, notiert.“ zweite Zeile „Groß geworden, Bobo.“ |
| Messung Dialog | „Messung eintragen“ / „Messung bearbeiten“ · „Gewicht in Gramm“, „Länge in cm“, „Kopfumfang in cm“, „Gemessen von“: Sundhedsplejerske / Arzt / Zuhause / Klinik · Hinweis „Alles leer lassen, was nicht gemessen wurde.“ |
| Messungen leer | „Noch nichts gemessen. Morgen kommt die Sundhedsplejerske.“ |
| Gewichtsverlust | „Tiefster Wert 3.240 g am 3. Tag, 6,9 % unter dem Geburtsgewicht. Geburtsgewicht am 10. Tag wieder erreicht.“ · über 10 %: „Mehr als 10 %: bitte mit Hebamme oder Sundhedsplejerske besprechen.“ · nach Tag 14 nicht erreicht: „Meist ist es nach 2 Wochen wieder erreicht: beim nächsten Besuch ansprechen.“ |
| Zunahme | „+238 g pro Woche“ / „20. Okt. bis 30. Okt. · 10 Tage · +340 g“ · WHO: „0 bis 4 Wochen: +650 g“ / „P20 · Median 879 g (WHO)“ |
| Zielgröße | „Tanner: 170 cm“ · „Hermanussen und Cole: 167,6 cm · P75“ · ohne Größen: „Tragt eure Größen in den Geburtsdaten ein, dann rechnet Boobo die Zielgröße.“ |
| Kurve fehlt | „Die deutsche Kopfumfang-Kurve (KiGGS) beginnt erst mit 4 Monaten. Größeren Zeitraum wählen oder WHO nehmen.“ |
| Import | „Kurve importieren“ · Hinweis „Für weitere Referenzen, z. B. aus der Schweiz oder für Frühgeborene. WHO, Deutschland und Dänemark sind schon eingebaut.“ · Toast „Meine Kurve importiert.“ + Messgrößen |

## Erweiterung 5: Statistik

| Stelle | Text |
|---|---|
| Tab / Karte | Tab „Statistik“ in der Leiste unten · Link „Statistik“ in „Letzte 24 Stunden“ |
| Titel | „Bobos Takt“ |
| Zeitraum | „7 Tage“ / „14 Tage“ / „30 Tage“ |
| Kennzahlen „Auf einen Blick“ | „Pro Tag“ (8,2 · „13 volle Tage“ / „noch kein voller Tag“) · „Abstand“ (2 h 57 · „meist 2 h 54“) · „Nachts“ (2,8 · „pro Nacht“) · „Längste Pause“ (4 h 48 · „bis gestern 09:14“) |
| Abschnitte (sichtbar nur Befunde) | „Wie oft pro Tag“ · „Zu welcher Zeit“ („Am häufigsten zwischen 11 und 12 Uhr.“) · „Das Muster“ · „Welche Seite“ („112 Mal in 14 Tagen, davon 10 Flasche · Links 51 %, Rechts 49 %“) · „Wie lange dazwischen“ („112 Abstände · kürzester 1 h 50“) · „Alle Tage als Tabelle“ |
| Erklärung hinter dem „i“ (Button „Erklärung zu „…““) | Auf einen Blick: „Pro Tag und Nachts sind Mittelwerte über vollständige Tage, heute zählt noch nicht mit. Nacht heißt 22 bis 7 Uhr. Abstand ist der Mittelwert von einer Mahlzeit zur nächsten, „meist“ der Median.“ · Wie oft pro Tag: „Der helle Balken ist heute, der Tag ist noch nicht vorbei. Einen Tag antippen zeigt seine Zahlen.“ · Zu welcher Zeit: „Alle Tage des Zeitraums zusammengezählt, je Stunde. Grau hinterlegt ist die Nacht von 22 bis 7 Uhr. Eine Stunde antippen zeigt ihre Zahl.“ · Das Muster: „Jede Zeile ein Tag, jedes Feld eine Stunde. Rosa: da kam Bobo, kräftiger bei mehr als einem Mal. Grau hinterlegt ist die Nacht. Ein Feld antippen zeigt, was da war.“ · Welche Seite: „Das Verhältnis Links zu Rechts zählt nur Mahlzeiten mit einer Seite, nicht Beide und nicht Flasche.“ · Wie lange dazwischen: „Abstand von einer Mahlzeit zur nächsten, eingeteilt in Stunden. Genau 3 Stunden zählen zu „3 bis 4 h“.“ |
| Zeile unter Diagramm | leer, bis man tippt; dann z. B. „Di., 28. Okt.: 9 Mal gestillt, davon 2 Flasche · Ø Abstand 2 h 42 · 3 nachts · 6 Windeln“, „3–4 Uhr: 5 Mal in 14 Tagen“, „Gestern, 6–7 Uhr: 1 Mal“ |
| Abstands-Klassen | „unter 1 h“ / „1 bis 2 h“ / „2 bis 3 h“ / „3 bis 4 h“ / „über 4 h“ |
| Leer | „Noch nichts zu sehen. Nach ein paar Tagen zeigt sich hier, wann Bobo kommt.“ |

### Wachstum, aufgeräumt (Ergänzung 6)

| Stelle | Text |
|---|---|
| Ohne Geburtsdaten | „Noch keine Geburtsdaten“ · Button „Geburtsdaten eintragen“ |
| Unter dem Diagramm | „4.200 g · P43 · z −0,2 · 1. Nov.“ · ohne Wert „Noch kein Wert“ |
| Diagramm leer | „Geschlecht fehlt“ · „KiGGS-Kopfumfang erst ab 4 Monaten“ · „Keine Werte für Kopfumfang in diesem Zeitraum“ |
| Zunahme | „3.240 g · −6,9 %“ / „Tiefster Wert · Tag 3“ · „Tag 10“ / „Geburtsgewicht wieder erreicht“ · „+650 g · P20“ / „0 bis 4 Wochen · WHO-Median 879 g“ · Befund „Mehr als 10 % unter Geburtsgewicht“ / „Mit Hebamme oder Sundhedsplejerske besprechen“ |
| Zielgröße | „170 cm“ / „Tanner · 161,5 bis 178,5 cm“ · „170,3 cm · P55“ / „Hermanussen-Cole · 160,2 bis 180,4 cm“ · fehlend „Größen der Eltern fehlen“ / „Unter Geburtsdaten eintragen“ |
