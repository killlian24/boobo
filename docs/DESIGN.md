# Boobo – Design-Tokens

Quelle: Claude-Design-Canvas „Boobo“ (Hell/Dunkel, Normal/Hunger/Leer, Icon, Tokens).
Umgesetzt in `public/app.css` als CSS-Variablen auf `:root`.

## Farben

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--bg` | #FBF7F2 | #1E1917 | Seitenhintergrund |
| `--surface` | #FFFFFF | #2A2422 | Karten, Buttons |
| `--line` | #ECE6DE | #3A3330 | Hairlines, Ring-Spur |
| `--text` | #1E1917 | #F5EFE6 | Text primär |
| `--text-2` | #6B645C | #A69E94 | Text sekundär |
| `--side-l` | #E890A8 | #E890A8 | Links (Fläche) |
| `--side-r` | #E8A95E | #E8A95E | Rechts (Fläche) |
| `--side-b` | #B49CDD | #B49CDD | Beide (Fläche) |
| `--side-f` | #5EC4B6 | #5EC4B6 | Flasche (Fläche) |
| `--side-text` | #1E1917 | #1E1917 | Buchstabe im Kreis |
| `--ink-l/r/b/f` | #B5405E / #A35E17 / #6B4FA8 / #1F7A6E | = Flächenfarben | Text in Seitenfarbe (Kontrast ≥ 4,7:1) |
| `--tint-l/r/b/f` | #FBE6EC / #FCF0DF / #EFE9F8 / #E3F4F1 | #3A2A2E / #3B2F24 / #332B3E / #243635 | Füllung hervorgehobener Button |
| `--toast` / `--toast-text` | #1E1917 / #F5EFE6 | #F5EFE6 / #1E1917 | Toast |
| `--toast-action` | #E890A8 | #B5405E | „Rückgängig“ |

Akzentregel: Ring, Vorschlagszeile und hervorgehobener Button tragen immer die Farbe der Seite,
die dran ist (`side` als Fläche, `ink` als Text, `tint` als Füllung). Es gibt keinen eigenen
Hunger-Ton: Hunger = Ring voll (Spur mit Tint gefüllt) plus Text.

## Typografie

System-Stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, "Segoe UI", system-ui`), Zahlen `tabular-nums`.
Größen in rem (16 px Basis): 1.75 (Uhrzeit im Ring), 1.5 (Hauptwert), 1.375 (Wortmarke, Dialogtitel),
1.0625 (Gruppentitel, Buttons, Listenzeit), 0.9375 (Fließtext, Toast, Abstand), 0.8125 (Labels, Untertitel).

## Maße

Radien 20 (Karte, Seiten-Buttons), 16 (Nachtragen, Toast, Felder), 12 (Toast-Button), 7 (Wortmarken-Icon).
Seitenrand 20, Kopfzeile 44, Ring 116 (Strich 9, r 52), Seiten-Buttons 2×2, gap 12, Höhe 88, Kreis 36,
Nachtragen 48, Gruppenzeile 28, Eintrag 52 (Kreis 32), Toast 56 (24 über Unterkante), Tippflächen ≥ 44.
Druckfeedback: `:active` skaliert auf 0.97, 120 ms; bei `prefers-reduced-motion` ohne Skalierung.

## Icon

Das doppelte o aus „Boobo“: linker Kreis voll, rechter Kreis als Ring, dunkel auf Rosé (#E890A8).
Quelle eckig (maskable), das System rundet. `public/icon.svg`, PNG 192/512 daraus erzeugt.

## Ergänzung 2: Erscheinungsbild, Nachtmodus, neutraler Tint

- Erscheinungsbild wählbar: System (Default, `prefers-color-scheme`), Hell (`html[data-theme="light"]`),
  Dunkel (`html[data-theme="dark"]`); Wahl in localStorage `boobo.theme`.
- Nachtmodus `html.night` (22–7 Uhr Ortszeit, abschaltbar, localStorage `boobo.night`): erzwingt dunkel und dämpft:
  bg #141110, surface #1E1917, line #2C2624, text #D9D2C8, text-2 #8E867C; Seiten- und Tintenfarben entsättigt
  (side/ink-l #C98E9D, -r #C9A277, -b #A396BF, -f #6FAAA2; tint-l #2A2023, -r #2A241D, -b #25212C, -f #1C2726);
  Toast #2C2624 / #D9D2C8.
- Neuer Token `--tint-n` (neutrale warme Fläche, z. B. Medikament „Geht jetzt“): hell #F5ECE1, dunkel #362E2A, Nacht #262019.
- Neue Maße: Windel-Buttons 56 hoch, Medikament-Zeile ≥ 64 mit Button „Genommen“ 44 hoch, Chips 36 hoch (Radius 12).

## Ergänzung 4: Statistik

- Erklärtexte stehen nicht in der Fläche. Jeder Abschnitt trägt rechts ein kleines „i“ (20 px Icon, 44 px Tippfläche,
  `--text-2`), das die Erklärung als Kasten (`--bg`, Haarlinie `--line`, Radius 12, 0.8125 rem) unter dem Titel ein- und
  ausblendet. Sichtbar bleiben Zahlen und Befunde.
- Kennzahl-Kacheln: Fläche `--bg` mit Haarlinie, Radius 16, Label 0.8125 rem, Wert 1.75 rem proportional (kein
  `tabular-nums`), Unterzeile 0.75 rem.
- Diagramme: eine Datenfarbe `--ink-l` (im Nachtmodus entsättigt), heute mit 45 % Deckung, Nachtband `--line` 45 %,
  Gitter `--line` 1 px, Balken höchstens 24 px breit mit 4 px Rundung oben, Achsentext 11 px `--text-2`.
  Raster Tag × Stunde: Felder Radius 2, leer `--line` 60 %, 1 Mal 50 %, ab 2 Mal 100 %.
- Seitenverteilung ist die einzige Stelle mit Seitenfarben (Segmentbalken 8 px, Liste mit Kreis 24 px).
