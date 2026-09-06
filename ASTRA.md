<!-- doc: role=dated independent audit and implementation handoff; stage=reference -->

# ASTRA — unabhängige Prüfung und Übergabe an 5.6 Luna Max

Prüfdatum: **6. September 2026**. Auftrag: ursprüngliche Idee, aktuelle Umsetzung,
Korrektheit, Bedienbarkeit, Funktionskomplexität und Effizienz mit frischem Blick prüfen.
Diese Datei dokumentiert Beobachtungen und Verbesserungsvorschläge. **Es wurden keine
Implementierungsänderungen vorgenommen.**

Der Bericht ist eine auf Wunsch des Nutzers angelegte Bestandsaufnahme. Er ersetzt weder
`AGENTS.md` noch die jeweiligen Issues als Entscheidungsautorität. Luna Max soll daraus
kleine, überprüfbare Umsetzungsschritte ableiten; offene Produkt- oder Vertragsentscheidungen
gehören anschließend in die zuständigen Issues.

## 1. Gesamturteil

Die grundlegende Architektur passt zum Produkt: eine statische, private Checkliste ohne
Backend, mit einem fest eingebundenen öffentlichen Katalog und browserlokalem Sammlungsstand.
Die Trennung zwischen Produzent und Consumer ist sorgfältig umgesetzt. Viele schwierige
Grenzfälle sind ausdrücklich modelliert und getestet. Ein Frameworkwechsel oder ein
kompletter Neubau wäre nicht gerechtfertigt.

**Das Ergebnis erfüllt die ursprüngliche Aufgabenstellung dennoch nicht vollständig.**
Am schwersten wiegt ein reproduzierbarer Verlust historischer Sammlungsdaten nach zwei
Katalogwechseln. Außerdem funktioniert der angebotene Backup-Import gerade bei beschädigtem
lokalem Zustand nicht. In der Oberfläche fehlen gelieferte Unterscheidungsmerkmale und Teile
der ursprünglich verlangten Fortschrittsübersicht. Die Veröffentlichung enthält einen
Erststartpfad, der ein fehlendes Produktionsmanifest zu großzügig behandelt.

Die Komplexität ist ungleich verteilt. Kleine Abfragen und native UI-Bausteine sind angemessen.
Speicherung, Wiederherstellung, Ergebnisdarstellung und Veröffentlichungsprüfungen tragen
hingegen viele Verantwortlichkeiten zugleich. Ein Teil davon schützt echte Invarianten; ein
anderer Teil entsteht durch doppelte Datenaufbereitung, Benachrichtigungen, Typdefinitionen
und historische Kompatibilitätsschichten. **Zuerst die nachgewiesenen Verhaltensfehler beheben,
danach an ihren konkreten Ursachen vereinfachen.**

## 2. Prüfstand und Beweisgrenzen

### 2.1 Exakt geprüfter Stand

| Bestandteil                  | Stand                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Lokaler Branch               | `codex/issue-81-final-acceptance`                                                               |
| Lokaler Commit               | `3724b4d710147dd23c8192a0958b6ded4287e600`                                                      |
| Abgefragtes `origin/main`    | `d570c92fe12d0221c8958c864612deca95dda061`                                                      |
| Vergleich                    | Unterschiedliche Commit-Identitäten, **identischer Dateibaum** laut `git diff HEAD origin/main` |
| Unabhängig geprüfte Live-App | `d570c92fe12d0221c8958c864612deca95dda061`                                                      |
| Produzentenrevision im Lock  | `98700119700523ee4939b7539103f7ba61ab03e6`                                                      |
| Katalogvertrag               | `1.0.0`                                                                                         |
| Katalogfingerprint           | `sha256:7f88c3c6dffc4b1fe73c868cd6be1baaa36116129b5217eaa1f17d590bd47d81`                       |
| Katalogbytes                 | 3.830.653; `sha256:5887db812354eaca90ae496af2bac82b4b8eceb9529c0919072d1ede03220da7`            |
| Migrationsbytes              | 1.591.310; `sha256:505509e697b93800902a6bd771c12d84541a400509fc6a2a805a976513938e44`            |

Im öffentlichen Snapshot befinden sich 990 Items: 720 `current-known` und 270 `research`,
verteilt auf 16 Localizations und 545 SetEditions. Das sind gemessene Snapshotwerte,
keine Zielzahlen, keine Behauptung vollständiger weltweiter Abdeckung und keine künftig
hart zu codierenden Konstanten.

Der Ausgangsarbeitsbaum war sauber. `origin/main` wurde abgefragt, ohne Branchwechsel,
Merge oder Rebase. Es wurden keine Issues, Kommentare, PRs oder Deployments geschrieben.
Die einzige beabsichtigte Änderung im Repository ist diese Datei.

### 2.2 Herangezogene Autoritäten

- [Consumer #2](https://github.com/m4s-ai/snoredex-checklist/issues/2), einschließlich aller
  36 zum Prüfzeitpunkt vorhandenen Kommentare: Produktumfang, Reihenfolge, spätere Abnahme.
- [Producer #229](https://github.com/m4s-ai/snoredex-data/issues/229) und
  [Producer #254](https://github.com/m4s-ai/snoredex-data/issues/254): ursprüngliche Entscheidung,
  Übergabe und öffentlicher Consumer-Vertrag.
- [Consumer #5](https://github.com/m4s-ai/snoredex-checklist/issues/5): Vertragsabnahme und
  ausdrückliche Entscheidung, Finish Candidates als Research zu behandeln.
- [Consumer #24](https://github.com/m4s-ai/snoredex-checklist/issues/24),
  [#72](https://github.com/m4s-ai/snoredex-checklist/issues/72) und
  [#79](https://github.com/m4s-ai/snoredex-checklist/issues/79): akzeptierte Navigation,
  Statussteuerung und progressive Ergebnisdarstellung.
- [Consumer #70](https://github.com/m4s-ai/snoredex-checklist/issues/70): notwendige Isolation
  von Bearbeitungsrevisionen, Mengen und Notizentwürfen.
- [Consumer #51](https://github.com/m4s-ai/snoredex-checklist/issues/51): AST-basierte,
  beratende Komplexitätsmessung und begrenzte Refactorings.
- [Consumer #81](https://github.com/m4s-ai/snoredex-checklist/issues/81): zusammengehörige
  Laufzeitdateien, Integritätsbindung und ausdrücklich akzeptierter manueller Rollback.

Die genannten Consumer-Issues wurden mit ihren Kommentaren gelesen. Spätere Entscheidungen
wurden gegenüber frühen Planständen berücksichtigt. PR-Verweise innerhalb dieser Historie
wurden nicht als zusätzliche, selbständig geprüfte Abnahmen übernommen.

Zusätzlich geprüft: Repository-Regeln, README, Architektur-, Produkt-, Design-, Spezifikations-,
Sicherheits- und Beitragsdokumentation, Attribution, relevante Upstream-Dokumentation,
Schemas/Lock/öffentliche Fixtures, Quellcode, Build- und Veröffentlichungswerkzeuge sowie Tests.
Für die Vereinfachungs- und UI-Prüfung wurden die Skills Ponytail und Impeccable angewendet.

### 2.3 Tatsächlich ausgeführte Verifikation

Verwendet wurden die Repository-Versionen **Node 26.7.0, npm 11.19.0 und TypeScript 7.0.2**.

| Prüfung                                                                                         | Ergebnis                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                                                 | PASS: Toolchain, Komplexitätsbericht, Format-Gate, Typecheck, Unit-/Boundary-Tests, Vertragstests, Smoke, Build, Reproduzierbarkeit, Artifact-Check |
| Unit-/Boundary-Tests                                                                            | 242 bestanden                                                                                                                                       |
| Vertragstests                                                                                   | 28 bestanden                                                                                                                                        |
| Reproduzierbarer Build                                                                          | Zwei Ausgaben identisch, 62 Dateien                                                                                                                 |
| `npm run test:browser`                                                                          | PASS in Chromium, Firefox und WebKit                                                                                                                |
| `node tests/accessibility-smoke.mjs` auf demselben gebauten Artefakt                            | PASS in allen 12 Kombinationen aus drei Engines und Desktop/320px/Phone/Tablet                                                                      |
| Live-HTTPS-Prüfung mit `scripts/smoke-pages.mjs` und expliziter erwarteter Produktionsidentität | PASS: beide Routen, Provenienz, aktive und deklarierte Rollback-Module, Bytes und Shell-Integritätsbindungen                                        |
| Eigene synthetische Zustandsproben                                                              | Datenverlust und blockierte Wiederherstellung reproduziert; siehe A01/A02                                                                           |
| Eigene isolierte Chromium-Bedienproben                                                          | Veraltete Backup-Buttons, Fokusverlust und zurückgesetzte Disclosures reproduziert; keine unerwarteten Konsolenfehler                               |
| Gerenderte Oberfläche                                                                           | Desktop sowie 320px in Hell/Dunkel geprüft; kein horizontaler Seitenüberlauf in den geprüften Ansichten                                             |
| Impeccable-Detektor                                                                             | Nur degradierter Fallback verfügbar; kein belastbarer vollständiger Detektorbefund                                                                  |

Die Accessibility-Suite filtert auf schwere/kritische Axe-Befunde. Ein PASS bedeutet weder
vollständige WCAG-Konformität noch eine neue manuelle Screenreader-Abnahme. Die vorhandene
datierte manuelle Evidenz wurde als historische Evidenz gelesen, nicht auf beliebige spätere
Revisionen übertragen. Echte Mobilgeräte, ältere Browserversionen, reale CDN-Störungen,
Stromausfälle und die aktuellen GitHub-Administratoreinstellungen wurden nicht vollständig
neu geprüft. Die Live-Prüfung war lesend; ein Rollback wurde in diesem Audit nicht ausgelöst.

Sämtliche neu erzeugten privaten Testzustände waren synthetisch und liefen in frischen,
isolierten Browserkontexten oder Memory-Storage. Reale Sammlungen und echte
`*.snoredex-private.json`-Exporte wurden nicht gelesen oder verarbeitet.

Lokale, nicht eingecheckte Belege liegen unter
`C:\Users\marku\AppData\Local\Temp\astra-audit-20260906`: Prüfprotokolle,
`state-probe.mjs`, `probe.mjs`, `performance.mjs`, deren Ergebnisse und Screenshots.
Diese temporären Dateien sind Hilfsevidenz; die wesentlichen Reproduktionen und Ergebnisse
sind hier festgehalten. Ein späteres Löschen des Temp-Verzeichnisses darf die Übergabe nicht
unverständlich machen.

## 3. Ursprüngliche Idee gegenüber dem Ergebnis

Die anfängliche Idee war eine praktische Sammlungsübersicht nach Karten und Sprachen mit
einem schnellen Blick auf den Fortschritt. Das Referenz-Workbook war ein Interaktionsvorbild.
Die spätere Entscheidung für eine eigene statische Website ergänzte zu Recht einen stabilen
Vertrag, getrennte Localities, sichere private Speicherung und verlustfreie Katalogwechsel.

Die heutige Umsetzung darf deshalb nicht allein an der Einfachheit eines Spreadsheets gemessen
werden. Umgekehrt macht ein ausgefeiltes Integritätsverfahren eine fehlende Sammlungsübersicht
oder unklare Kartenunterscheidung nicht weniger relevant.

| Erwartung                                            | Aktuelles Ergebnis                                                                       | Bewertung                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Statische, mobile Checkliste ohne Backend/Login      | Native HTML/CSS/TypeScript, öffentliche statische Dateien                                | Gut und angemessen                                                   |
| Ein gepinnter Produzentenvertrag                     | Vendor-Snapshot, Lock, Schema-/Semantik-/Byteprüfungen                                   | Gut                                                                  |
| Locality/Language/SetEdition sauber getrennt         | Gruppierung über IDs, keine bloße Zusammenfassung gleicher Sprachen                      | Gut                                                                  |
| Research getrennt von Sammlungsfortschritt           | Read-only, aus dem Nenner ausgeschlossen                                                 | Gut; genaue Itemklasse könnte sichtbarer sein                        |
| Karte eindeutig erkennen                             | Name/Nummer/Finish vorhanden; Edition, Seltenheit und Größe fehlen als eigene Anzeigen   | Unvollständig, A03                                                   |
| Need/Ordered/Have/Skip, Mengen, Notizen              | Implementiert und breit getestet                                                         | Gute Basis; Benachrichtigungen unnötig teuer, A09                    |
| Front cover mit Gesamt- und Localization-Fortschritt | Startseite bietet Verzeichnis; Fortschritt erst in ausgewählten Ergebnisansichten        | Produktlücke, A08                                                    |
| Suche, Filter und stabile Links                      | Native GET-Formulare und kanonische Kriterien                                            | Gut; Suche/Sortierung mehrfach berechnet, A10                        |
| Sofortiges Backup nach Bearbeitung                   | Nach erstem Speichern bleiben Buttons deaktiviert                                        | Fehler, A05                                                          |
| Wiederherstellung bei beschädigtem Zustand           | Gültiger Import wird durch beschädigten vorhandenen Zustand blockiert                    | Fehler, A02                                                          |
| Kein stiller Verlust über Katalogwechsel             | Einzelübergang berücksichtigt alte aktive IDs, ältere Recovery wird später überschrieben | Schwerer Fehler, A01                                                 |
| Sicherer, nachvollziehbarer Rollout                  | Starke Modulbindung und Live-Smoke                                                       | Gut; 404-Erststartpfad und Katalogwechsel-Rollback beachten, A04/A12 |
| Leicht wartbarer Code                                | Kleine Module neben sehr großen Speicher-/UI-/Prüfmodulen                                | Gemischt; gezielte Vereinfachung sinnvoll                            |

### Was ausdrücklich erhalten bleiben sollte

1. Keine Laufzeitabhängigkeit von mutablem Upstream und keine Rekonstruktion von Produzentendaten.
2. Semantischer Fingerprint und exakter Byte-Digest als unterschiedliche Prüfungen.
3. Atomare Veröffentlichung von Snapshot und Lock sowie Fail-closed an Vertrauensgrenzen.
4. Opaque Item-IDs, producerbestimmte Fortschrittsklassen und separate Research-Darstellung.
5. Native GET-Formulare, Radio-Gruppen, `details`, `dialog`, lokale Fonts und einfache Styles.
6. Revisionsgebundene Laufzeitmodule, CSP/SRI, aktive und deklarierte Rollback-Generation.
7. Schutz vor veralteten asynchronen Speicherabschlüssen, parallelen Tabs und unsicheren Commits.
8. Größenlimits und Validierung für Imports, Mengen und Notizen; Text-APIs für fremde Inhalte.
9. Bildplatzhalter, solange keine dokumentierte Freigabe echter Kartenbilder vorliegt.
10. Tests auf tatsächlichen Fehlerpfaden, plattformübergreifende Build-Reproduzierbarkeit und
    Browserprüfungen. Diese Sicherungen sind keine entbehrliche Komplexität.

## 4. Priorisierte Befunde

Prioritäten: **P1** = Datenverlust/Wiederherstellung oder grundlegende Veröffentlichungssicherung;
**P2** = relevante Produkt-, Bedienungs-, Skalierungs- oder Wartungslücke;
**P3** = begrenzte Verbesserung ohne nachgewiesenen unmittelbaren Schaden.
Kein P0 wurde nachgewiesen. Prioritäten beziehen sich auf die Auswirkung bei Eintritt,
nicht auf eine behauptete Häufigkeit in echten Sammlungen.

### A01 — P1: Zweiter Katalogwechsel vernichtet ältere Orphan-Daten

**Beleg:** [browser-reconciliation.ts](src/state/browser-reconciliation.ts), insbesondere
`preserveRecovery` ab Zeile 60 und die Rotation am Ende von `reconcileBrowserState`
(Zeilen 193–202); eigener ausgeführter Memory-Storage-Test.

Reproduktion mit ausschließlich synthetischen Daten:

1. Katalog A: aktive Datensätze X und Y, jeweils `have`, Menge 1.
2. Explizite Migration A → B: X wird `retired-1:0`, Y bleibt erhalten.
3. Ergebnis: aktiver Zustand B enthält Y; die Recovery-Kopie A enthält X und Y.
4. Explizite Migration B → C: Y bleibt erhalten.
5. Ergebnis: aktiver Zustand C enthält Y; Recovery wird durch B ersetzt und enthält nur Y.

Beide Aufrufe liefern `{ ok: true, changed: true }`. Nach dem ersten ist X in der lokalen
Autorität noch vorhanden, nach dem zweiten in **keinem** gespeicherten Wert mehr. Dafür ist
weder ein unsicheres Mapping noch ein Speicherfehler erforderlich. Ein externes Backup ist
für diesen Pfad nicht Voraussetzung.

Die reine Reconciliation-Funktion bilanziert den jeweiligen aktiven Eingang. Der Browseradapter
behandelt aber die einzige Recovery-Kopie gleichzeitig als kurzfristigen Rollback-Slot und
langfristigen Aufbewahrungsort ausgeschiedener Records. Diese beiden Aufgaben sind nicht
gleichwertig. Eine korrekte Bilanz für B → C schützt nicht die schon zuvor ausgeschiedenen IDs
aus A. Der Kommentar zur gewollten Slot-Rotation beschreibt genau diesen Konflikt.

**Kleinste sichere erste Änderung:** Eine Rotation blockieren, wenn sie den einzigen erhaltenen
Zustand bereits ausgeschiedener oder ungeklärter Records verdrängen würde. Der letzte gute
Zustand muss dabei unverändert bleiben. Anschließend einen ausdrücklich versionierten Entwurf
für dauerhafte Orphan-/Konflikterhaltung neben dem begrenzten Rollback-Snapshot festlegen.
Auch Import, Clear, Restore und normale Speicherzugriffe müssen diesen Bestand respektieren.

**Nicht tun:** Historische Zustände ungeprüft zusammenführen, Records auf alle Split-Ziele
kopieren, alte IDs als neue trackbare Items ausgeben oder unbegrenzt komplette Snapshots sammeln.

**Abnahme:** A → B → C mit Retirement, 1:N, N:1 und Research-Übergang; danach Export/Import,
Clear/Restore, Reload, Rollback und erneuter Vorwärtswechsel. Alle ursprünglichen Records samt
Mengen/Notizen sind aktiv, ausdrücklich sicher migriert oder weiterhin nachvollziehbar erhalten.
Quota-, Write- und Readback-Fehler dürfen keine Teilrotation hinterlassen. Ein ausführbares
Minimalbeispiel steht in Abschnitt 8.

### A02 — P1: Beschädigter Speicher blockiert den versprochenen Wiederherstellungsweg

**Beleg:** [authority.ts](src/state/authority.ts), `readStateAuthority` ab Zeile 92;
[backup.ts](src/state/backup.ts), `read`, `exportActive`, `exportRecovery`, `prepareImport`
ab Zeile 438; [app.ts](src/site/app.ts), Recovery-Fehlermeldungen und `renderRecoveryTools`.

Zwei bestätigte Fälle:

- Aktiver Zustand ist gültig, Recovery-Sidecar enthält beschädigtes JSON. Die gesamte Autorität
  wird als unlesbar bewertet; selbst der Export des unabhängig gültigen aktiven Zustands scheitert.
- Aktiver Zustand enthält beschädigtes JSON. Ein vollständig gültiges portables Backup wird
  ausgewählt. `prepareImport` bricht beim Lesen des vorhandenen Zustands ab, bevor der Import
  überhaupt validiert und als Recovery angeboten werden kann.

Die Browserprobe zeigt daraufhin die Aufforderung, ein gültiges Backup zu importieren, um den
Zustand zu reparieren. Genau diese Aktion führt erneut zu `LOCAL_STATE_UNREADABLE`. Die UI
führt den Nutzer in eine Schleife. Das sichere Blockieren normaler Schreibzugriffe ist richtig;
das gleichzeitige Blockieren jedes Reparaturwegs ist es nicht.

**Vorschlag:** Normale Bearbeitung weiter fail-closed halten. Einen eng begrenzten Recovery-Pfad
vorsehen, der unabhängig lesbare Teilbestände exportierbar macht und beschädigte Originalbytes
vor bestätigter Wiederherstellung erhält. Ein gültiges Backup muss zumindest unabhängig vom
kaputten Istzustand geprüft und in einer ehrlichen Vorschau angeboten werden können. Für
Quarantäne/Erhaltung, Platzmangel und inkompatible Versionen eine eindeutige Regel festlegen.

**Nicht tun:** Fehler als leere Sammlung behandeln, den Browserstorage pauschal löschen oder
Schema-/Integritätsprüfung für normale Imports abschalten. Unlesbare Bytes bleiben untrusted.

**Abnahme:** Gültig/kaputt, kaputt/gültig und kaputt/kaputt für Active/Recovery; jeweils gültiger,
ungültiger und inkompatibler Import; Abbruch, Quota-Fehler, stale Preview und erfolgreicher
bestätigter Restore. Lesbare Daten bleiben exportierbar; Fehlermeldungen nennen ausschließlich
Aktionen, die im jeweiligen Zustand tatsächlich möglich sind.

### A03 — P2: Wichtige Kartenmerkmale fehlen in der Darstellung

**Beleg:** [app.ts](src/site/app.ts), `itemRowCollisionKey`/`itemRowDisambiguators`
ab Zeile 152, `renderItemDetails` ab 621 und `renderItemRow` ab 1301;
[item-presentation.ts](src/site/item-presentation.ts).

Der Vertrag liefert `edition`, `editionAssignmentStatus`, `rarity`, `cardSize` und `errorClass`.
Diese Informationen werden nicht als entsprechende Felder angezeigt. Im Snapshot haben
57 Items eine Edition, alle 990 ein Rarity-Objekt und einen `cardSize`-Wert; Größe kann ausdrücklich
`unknown` sein. `errorClass` ist aktuell überall null und deshalb derzeit kein sichtbarer
inhaltlicher Verlust.

Ein konkretes Paar trackbarer Items liegt in `LOCALIZATION:WEST:it`,
`EDITION:WEST:Italian:JU`, Nummer 11, Finish `holo`:

- `item-7c2d03fa-ab81-5384-8c49-8df03c302572`: `Unlimited`.
- `item-f3389482-15ad-5b3d-89df-92d88250aae6`: `1st Edition`.

Die primäre Zeilendarstellung unterscheidet solche Kollisionen über „Variation 1/2“, nicht
über die gelieferte Edition. Beim zweiten Beispiel ist der Stempel `EDIZIONE 1` immerhin in
den aufgeklappten Markings vorhanden. Deshalb wäre die Behauptung falsch, beide Items seien
überhaupt nicht unterscheidbar. Trotzdem muss der Nutzer ein bekanntes Hauptmerkmal aus
einem Detailtext erschließen. Ein Ordinal wie „Variation 2“ erklärt keine physische Identität
und kann sich durch zusätzliche Katalogeinträge verschieben.

Die ursprüngliche Zeilenanforderung in #2 nennt Edition, Seltenheit und Größe ausdrücklich.
Die Startkennzeichnung „Trackable“ bzw. „Research · read-only“ ersetzt zudem nicht die genaue
Unterscheidung zwischen bestätigtem Printing, Finish Candidate und Research Placeholder.

**Vorschlag:** Gelieferte identitätsrelevante Unterschiede knapp in die primäre Zeile aufnehmen;
vollständige bekannte Details einschließlich Evidenzstatus im Disclosure. Technischen Finish
und Finish-Familie weiter getrennt halten. Kandidaten als Kandidaten benennen. Unbekannte Werte
ehrlich darstellen. Keine Rückschlüsse aus Bild, Seltenheit oder Produktname erzeugen.

**Abnahme:** Synthetische gleichnamige Items unterscheiden sich jeweils nur in Edition, Größe,
Foil/Marking oder Itemklasse. Sie bleiben visuell und per Accessible Name identifizierbar,
auch ohne echtes Kartenbild. Die konkrete italienische Jungle-Paarung bleibt ein öffentlicher
Plausibilitätscheck, nicht die einzige Testfixture.

### A04 — P1: HTTP 404 kann eine bestehende Produktion zum vermeintlichen Erststart machen

**Beleg:** [deploy-pages.yml](.github/workflows/deploy-pages.yml), Zeilen 192–214;
[check-production-adoption.mjs](scripts/check-production-adoption.mjs), ab Zeile 67;
[retain-runtime-assets.mjs](scripts/retain-runtime-assets.mjs), ab Zeile 260;
[create-deployment-manifest.mjs](scripts/create-deployment-manifest.mjs), ab Zeile 97.

Bei HTTP 404 für das aktuelle `deployment.json` setzt der Workflow Fingerprint, Revision und
Manifestpfad auf leer. Ohne diesen Pfad akzeptiert der Adoption-Check einen nichtleeren
Migrationsweg zum Ziel, ohne die tatsächlich bisher publizierte Quelle zu kennen. Lokal lässt
sich der Check ohne Produktionsvariablen erfolgreich ausführen: `production adoption migration
target ok`. Das ist als echter Erststartpfad vorgesehen, aber nicht auf einen echten Erststart
beschränkt.

Die nachfolgenden Programme behalten ohne Vorgängermanifest keine vorherige Runtime-Generation
und erzeugen eine neue Manifesthistorie mit leeren `sourceFingerprints`. Ein fehlendes Manifest
einer bereits veröffentlichten Site kann so die Prüfung gegen ihre bekannte Vorgeschichte
umgehen. HTTP 500 und andere Fehler werden dagegen korrekt blockiert.

**Evidenzgrenze:** Kontrollfluss und lokaler Guard sind bestätigt. Es wurde kein 404 auf der
öffentlichen Site erzeugt und kein fehlerhafter Deploymentlauf ausgelöst. Die aktuell live
geprüfte Veröffentlichung ist konsistent.

**Vorschlag:** Für dieses bereits veröffentlichte Repository ist ein fehlendes Produktionsmanifest
ein Blocker. Falls ein Erststart weiterhin unterstützt werden muss, benötigt er einen getrennten,
explizit autorisierten und überprüfbaren Bootstrapzustand. „HTTP 404“ allein beweist nicht, dass
noch nie private Browserdaten gegen eine Produktion entstanden sind.

**Abnahme:** Bestehende Produktion plus 404, leere Antwort, defektes JSON, falsche Identität und
falsche Historie blockieren vor Upload/Deployment. Retention und Vorgängerfingerprints bleiben
erhalten. Einen echten autorisierten Erststart separat testen. Dafür keinen Gate-Bypass in
allgemeine Umgebungsvariablen ohne überprüfte Herkunft verlagern.

### A05 — P2: Backup-Schaltflächen werden nach dem ersten Speichern nicht aktualisiert

**Beleg:** [app.ts](src/site/app.ts), `renderRecoveryTools` Zeilen 1141–1299.
`refresh()` wird beim Aufbau ausgeführt; der Bereich hört nicht auf spätere Zustandsänderungen.

Bestätigte Browserfolge: frischer Zustand → „Export collection“ disabled → erstes Item auf Have
setzen → sichtbare Bestätigung „Saved“ abwarten → Export weiterhin disabled → Reload → Export
enabled. `Clear collection` verwendet dieselbe einmalige Zählung.

**Vorschlag:** Die Verfügbarkeit aus dem bestätigten aktuellen Zustand aktualisieren, entweder
über die vorhandene Controller-Benachrichtigung oder einen gezielten Refresh beim Öffnen der
Backup-Werkzeuge. Subscription und Cleanup ausdrücklich besitzen; keine neue Eventbus-Schicht.

**Abnahme:** Erste Speicherung, Änderungen aus einem zweiten Tab, Clear/Restore und fehlgeschlagener
Commit aktualisieren die erlaubten Aktionen ohne unnötigen Reload. Ein ungespeicherter Entwurf
darf nicht als erfolgreich gespeicherter Exportinhalt erscheinen.

### A06 — P2: Statusfilter verliert nach einer Bearbeitung den Tastaturfokus

**Beleg:** [app.ts](src/site/app.ts), `renderResults` ab 1348 und Status-Subscription ab 1413.

Bei `?research=false&status=need` ein Item auf Have setzen. Es fällt korrekt aus den Ergebnissen,
aber der vollständige Ergebnisbaum wird ersetzt. Die ausgeführte Browserprobe ermittelt danach
`document.activeElement.tagName === 'BODY'`. Die nächste Tastaturnavigation hat keinen sinnvollen
Anschluss an die zuvor bearbeitete Zeile.

**Vorschlag:** Vor der Änderung einen passenden Fokusnachfolger bestimmen: nächstes Ergebnis,
sonst vorheriges oder die beständige Ergebniszusammenfassung. Nur tatsächlich betroffene
Bereiche ersetzen und den Wechsel knapp ankündigen. Statusfilter weiterhin aus bestätigten
Sammlungszuständen ableiten.

**Abnahme:** Erste/mittlere/letzte/einzige Zeile, Erfolg und Speicherfehler, alle drei Engines.
Der Fokus bleibt sichtbar und sinnvoll; Screenreader bekommen keine vollständige Ergebnisliste
als Live-Region vorgelesen.

### A07 — P2: „Show more“ baut alte Zeilen erneut auf und schließt geöffnete Details

**Beleg:** [app.ts](src/site/app.ts), `renderResults`, insbesondere ab Zeile 1610;
eigene Browserprobe.

Die Begrenzung auf 24 initiale Items ist sinnvoll und aus #79 begründet. Beim Nachladen wird
jedoch wieder `renderResults` mit höherem Limit ausgeführt. Bereits gemountete Zeilen,
Dialoge und Listener entstehen neu. Zuvor geöffnete Mengen- und Evidenz-Disclosures sind
danach geschlossen; das wurde direkt reproduziert.

Bei schrittweisem vollständigem Aufdecken wächst die wiederholte Zeilenarbeit wie
`24 + 48 + 72 + …`, statt jedes neue Item einmal aufzubauen. Der Controller erhält bestimmte
Drafts weiter; **ein Verlust gültiger Draft-Inhalte durch diese Probe wurde nicht nachgewiesen**.
Der belegte Fehler betrifft DOM-/Bedienzustand und unnötige Arbeit.

**Vorschlag:** Nur zusätzliche Zeilen einfügen und beständige Gruppen-/Statuscontainer erhalten.
Such-/Filterwechsel dürfen ein neues Ergebnis erzeugen; bloßes Erweitern sollte vorhandene
Interaktionen behalten. Keine Virtualisierungsbibliothek für 990 Items einführen.

Die letzte Erweiterung fokussiert derzeit die Abschlusszusammenfassung. Das ist eine in #79
bewusst dokumentierte Entscheidung. Ob der Fokus auch dann besser auf die erste neue Zeile
geht, ist eine nachrangige UX-Prüfung, kein hier neu bewiesener Konformitätsfehler.

**Abnahme:** Offene Disclosures, fokussierte Controls und Drafts bleiben beim Erweitern erhalten.
Neue Zeilen sind direkt per Tastatur erreichbar; Reihenfolge, leere bekannte Editionen beim
Browse-Modus, Zähler und Research-Grenze bleiben korrekt. Listenerzahl darf nicht anwachsen,
wenn gleiche Ansichten wiederholt neu gefiltert werden.

### A08 — P2: Die ursprüngliche Fortschrittsübersicht ist nur teilweise vorhanden

**Beleg:** [app.ts](src/site/app.ts), `renderIndex`, `renderProgress` ab 488 und früher Return
in `renderResults` ab 1388; [results.ts](src/site/results.ts), `buildProgressViewModel`.

#2 verlangt ein Front cover mit Gesamtfortschritt und dynamischen Localization-Zeilen mit
Total/Have/Ordered/Need/Skip/Research. Auch Setgruppen sollten Fortschritt und bekannte
Veröffentlichungsdaten zeigen. Die Startseite enthält heute ein öffentliches Verzeichnis;
die nackte `/collection/`-Route zeigt zunächst nur die Aufforderung zu Suche oder Auswahl.
Fortschritt erscheint erst mit Auswahl/Filter. Prozentwerte werden berechnet, aber nicht als
solche angezeigt; eine vollständige Statusverteilung pro Localization fehlt.

#72 und #79 begründen das aktuelle Verzeichnis und den kleinen Homepage-Datenpfad. Das ist
eine sinnvolle spätere Gestaltung, aber keine klar dokumentierte Aufhebung sämtlicher
ursprünglicher Übersichtsanforderungen. Deshalb zunächst als **Produktlücke abgleichen**,
nicht die Startseite ungefragt wieder mit privater Zustandslogik und Vollkatalog beladen.

**Vorschlag:** Eine kompakte Übersicht auf `/collection/` anbieten; die öffentliche Startseite
kann leicht bleiben. Zuständigkeit und gewünschte Platzierung im Folgeissue festlegen.
Gesamt-, Localization- und ausgewählte Set-Fortschritte aus derselben Logik ableiten.

**Abnahme:** Prozent und absolute Werte stimmen bei leerem Zustand, nur Research, Skip,
Have/Ordered und Mengen größer 1. Textsuche und Statusfilter ändern nicht den Nenner des
gewählten Sammlungsscope. Unlesbarer privater Zustand wird nicht als 0 % Sammlung ausgegeben.

### A09 — P2: Ein Speichervorgang benachrichtigt unnötig fast die ganze Sammlung

**Beleg:** [collection-state.ts](src/site/collection-state.ts), `finishOperation`
Zeilen 638–679 und `notify` ab 725; [app.ts](src/site/app.ts), `statusKey` ab 875,
Progress-/Status-Subscriptions ab 1403.

Ein erfolgreicher Commit nimmt alle bisherigen und alle neuen gespeicherten Item-IDs in
`touched` auf. Für diese IDs erfolgt jeweils eine Benachrichtigung. Globale Listener erzeugen
dabei wieder Status-Maps und sortierte Statussignaturen, auch wenn nur ein Item geändert wurde.
Mit M gespeicherten Records kann allein diese Signaturarbeit pro Commit ungefähr
**O(M² log M)** erreichen. Die nötige Serialisierung eines vollständigen Zustands ist davon
zu unterscheiden; ihre Existenz rechtfertigt keine Benachrichtigung aller unveränderten Zeilen.

Ausgeführte Chromium-Messung, fünf Statuswechsel je Größe, Median von Klick bis sichtbarem
„Saved“, synthetische Daten:

| Vorbelegte Records |  Median |
| -----------------: | ------: |
|                  0 |  0,5 ms |
|                100 |  4,2 ms |
|                720 | 58,8 ms |

Die 720er-Läufe lagen zwischen 57,4 und 64,0 ms. Das ist ein lokaler Lauf auf einem schnellen
Windows-Rechner, ohne mobile CPU-Drosselung. Es ist kein INP-/Lighthouse-Wert und keine
isolierte CPU-Profilierung der Signaturfunktion. Messung und Code zeigen aber eine unnötige
Skalierung bereits bei der heutigen Kataloggröße.

**Vorschlag:** Nur tatsächlich geänderte bestätigte Records bzw. einen Batch mit betroffenen
IDs melden. Statusänderung einmal je Commit erkennen; Notizänderungen dürfen nicht die gesamte
Fortschrittsaufbereitung auslösen. Bestehende Operations-/Feldrevisionen aus #70 erhalten.

**Abnahme:** Mengen/Notizen/statusgleiche Saves, veralteter Abschluss, parallele Operationen,
unsicherer Commit und Änderungen aus anderen Tabs bleiben korrekt. Ein instrumentierter
Regressionstest begrenzt unnötige globale Benachrichtigungen; Zeitmessungen ergänzen ihn,
ersetzen ihn aber nicht durch einen flakigen Millisekunden-Grenzwert.

### A10 — P2: Suche, Sortierung und Gruppierung bereiten dieselben Daten mehrfach auf

**Beleg:** [results.ts](src/site/results.ts), Zeilen 49–114 und 165–215;
[app.ts](src/site/app.ts), gruppenweise Itemfilter ab Zeile 1486.

- `searchTerms(criteria.q)` läuft pro Item erneut.
- `publicSearchText(item)` wird innerhalb von `terms.every(...)` pro geprüftem Suchwort neu
  zusammengesetzt und normalisiert.
- Ergebnis-ViewModel und Browse-Hierarchie filtern und sortieren unabhängig voneinander.
- Jeder `localeCompare`-Vergleich bekommt erneut dieselben Locale-/Numeric-Optionen.
- Die Hierarchie läuft je Localization durch alle SetEditions.
- Der Renderer durchsucht für Editionen erneut die gesamte Itemliste zur Disambiguierung.
  Die Begrenzung gemounteter Zeilen verhindert diese vorgelagerte Arbeit nicht vollständig.

Lokale Messung: Median aus neun Läufen nach drei Warm-ups, 990 Items. Werte sind getrennte
Funktionsaufrufe; sie enthalten weder den gesamten Seitenstart noch sämtliche DOM-Arbeit.

| Query              | Filter/Sortierung | Hierarchie einschließlich eigener Filter/Sortierung |
| ------------------ | ----------------: | --------------------------------------------------: |
| keine              |           6,21 ms |                                            11,57 ms |
| `snorlax`          |           7,39 ms |                                            11,60 ms |
| `snorlax non-holo` |           2,99 ms |                                             4,56 ms |
| zwölfmal `snorlax` |          17,28 ms |                                            21,83 ms |

Mit N Items, T Suchwörtern, L Localizations und E Editionen entstehen wiederholte
Suchtextkosten bis O(N × T × Textlänge), doppelte Sortierung und zusätzliche L×E-/E×N-Scans.
Bei 990 Items ist das noch handhabbar, aber ohne Produktnutzen teuer.

**Vorschlag:** Suchwörter einmal parsen; je validiertem unveränderlichem Snapshot Suchtext,
ID-Maps und stabile Reihenfolge einmal vorbereiten. Ein gefiltertes Ergebnis für Zusammenfassung
und Gruppierung verwenden. Einen wiederverwendeten `Intl.Collator` prüfen. Maps nach
SetEdition/Localization reichen; kein Suchserver, Worker, Fuzzy-Framework oder allgemeiner Cache.

**Abnahme:** Gleiche AND-Semantik, Unicode-Normalisierung, natürliche Nummernsortierung,
producerbestimmte Reihenfolge, Tie-Breaker und stabile Gruppen bei doppelten Labels.
Private Notizen und Mengen dürfen nicht versehentlich Teil der öffentlichen Suche werden.

### A11 — P2: Homepage importiert weiterhin umfangreiche Collection-Logik

**Beleg:** Statische Imports am Anfang von [app.ts](src/site/app.ts), gebauter Importgraph
und eigene Resource-Messung.

Positiv: Die normale Startseite lädt weder `snapshot.js` noch `migrations.js`; #79 hat den
größten unnötigen Datenblock entfernt. Sie lädt aber weiterhin den gemeinsamen Dispatcher
mit Collection-Renderer sowie Controller-, Query-, Results- und Catalogue-Module.

| Messwert                                                         |     Beobachtung |
| ---------------------------------------------------------------- | --------------: |
| Homepage erfasste decodierte Ressourcen einschließlich CSS/Fonts |   185.029 Bytes |
| Darin `app.js`                                                   |    75.199 Bytes |
| Darin `collection-state.js`                                      |    25.951 Bytes |
| Directory-Snapshot                                               |     4.903 Bytes |
| Collection erfasste decodierte Ressourcen                        | 4.157.505 Bytes |
| Initial sichtbare Collection-Items / DOM-Elemente der Probe      |      24 / 2.403 |

Diese Ressourcenwerte sind keine behaupteten komprimierten Internet-Transfergrößen und schließen
nicht automatisch jede Navigations-/Protokollkomponente ein. Der lokale Server lieferte ohne
HTTP-Kompression. Die tatsächliche Bandbreite hängt vom Host ab.

**Vorschlag:** Gemeinsamen Dispatcher klein halten und Homepage-/Collection-Implementierung
bedingt laden. Die historisch erforderliche Einstiegskompatibilität und die in #81 eingeführte
Integritätsbindung dabei explizit testen. Den Sicherheits-Bootstrap nicht entfernen, nur um
eine schönere Bundlezahl zu erhalten.

**Abnahme:** Homepage fordert keine Collection-Controller-/State-/Vollkatalogmodule an; beide
Routen bleiben in alten/neuen Shellkombinationen sicher. Gemessenen Graph vor/nachher berichten.

### A12 — P2: Rollback nach einem echten Katalogwechsel ist enger unterstützt als der Produkttext nahelegt

**Beleg:** [create-deployment-manifest.mjs](scripts/create-deployment-manifest.mjs),
`rollbackSource` ab Zeile 137; [deploy-pages.yml](.github/workflows/deploy-pages.yml),
`sameCatalogueDeployment` ab 241; Abnahmehistorie #81.

Ein deklarierter Rollback wird nur angelegt, wenn aktueller und vorheriger Katalogfingerprint
gleich sind. Der Workflow verlangt diese Gleichheit zusätzlich. Die nachgewiesene Übung in
#81 wechselte App-Revisionen bei gleichem Katalogfingerprint. Sie beweist daher nicht, dass
ein gerade eingeführter neuer Katalog auf den vorherigen Katalog zurückgerollt werden kann.

Das Blockieren ungeklärter Rückmigrationen ist richtig. Die Lücke besteht zwischen dem
allgemeinen Versprechen „vorherigen App-Commit und Lock redeployen“ und der tatsächlich
unterstützten Rollbackmatrix. Ein Vorwärts-Katalogwechsel kann ohne deklarierte Rückfallversion
enden; das muss vor dem nächsten solchen Wechsel bewusst entschieden sein.

**Vorschlag:** Unterstützte Fälle in Runbook und Folgeissue klar trennen: App-only-Rollback,
Katalogwechsel, State-Version-Wechsel. Für einen echten Katalogrollback die benötigte
Producer-Autorität, Browserstate-Erhaltung einschließlich A01 und konkrete Wiederanlaufstrategie
festlegen. Gleichheitsprüfungen erst nach dieser Absicherung erweitern.

**Abnahme:** Neuer Fingerprint, Bearbeitung danach, Rückkehr zum vorherigen App-/Lock-Paar
und erneute Vorwärtskehr mit vollständiger Zustandserhaltung. Wenn dieser Fall bewusst nicht
unterstützt werden soll, muss die Veröffentlichungsvoraussetzung samt Recovery-Alternative
ausdrücklich akzeptiert und dokumentiert sein.

### A13 — P2: Fehlerseite verwechselt Integritätsfehler mit ungültigen Links

**Beleg:** [app.ts](src/site/app.ts), `renderInvalid` ab Zeile 460 und Aufrufe im Bootstrap
ab 1741.

Bei Katalog-/Versions-/Digest- oder Modulproblemen wird dieselbe Überschrift „Invalid checklist
link“ verwendet wie bei falschen Query-Kriterien. Im Fail-closed-Fall behauptet der sichtbare
Text sogar, es sei kein Katalog gelesen worden, obwohl ein geladener Katalog bereits an der
Validierung gescheitert sein kann. Die knappe Statusregion „Catalogue unavailable“ ist zutreffender.

Wenn bereits das Entry-Modul durch SRI blockiert wird, kann dieses Modul selbst keine Fehlerseite
mehr zeichnen. Dafür muss die statische Shell einen brauchbaren Ausgangszustand bieten.
Dieser zweite Fall wurde nicht als neue vollständige UX-Reproduktion gemessen; er folgt aus
der Ausführungsgrenze und sollte als eigener Browserfall geprüft werden.

**Vorschlag:** Kriterienfehler, Katalog nicht verfügbar, inkompatible Version und privater
Speicherfehler als getrennte, kurze Nutzerzustände. Keine privaten Rohdaten oder technischen
Stacks anzeigen. Ein sicheres „erneut laden“ darf keine beschädigten Daten löschen.

**Abnahme:** Dieselbe gültige URL mit fehlender Datei, manipuliertem Modul, falschem Digest,
unsupported Contract und echtem Queryfehler; jede Ansicht erklärt den richtigen Zustand und
bleibt ohne private Mutation bedienbar.

### A14 — P2: Quelltypprüfung wird an Site-/State-Übergängen umgangen

**Beleg:** [app.ts](src/site/app.ts), lokale `Backup*`-/`BrowserStorageModule`-Interfaces;
[collection-state.ts](src/site/collection-state.ts), `PersistenceResult` ab 21 und Imports
ab 739; [build-site.mjs](scripts/build-site.mjs); [tsconfig.json](tsconfig.json).

Die separate Ausgabe von Site und State führt zu handgeschriebenen Spiegeltypen,
`@ts-expect-error` an Laufzeitimports und anschließenden Casts. Einige Resulttypen verwenden
`ok: boolean` plus optionale `value/error`, obwohl die Domäne präzisere Erfolgs-/Fehlerunionen
hat. Ein späterer API-Drift kann deshalb den Typecheck passieren und erst zur Laufzeit auffallen.

**Vorschlag:** Zuerst Typen per `import type` aus der tatsächlichen Autorität übernehmen und
Outputpfade nachvollziehbar typisieren. Wenn nötig eine gemeinsame TS-Ausgabestruktur prüfen.
Kein Bundler-/Frameworkwechsel allein dafür und keine generische Plugin-/Adapterarchitektur.

**Abnahme:** Änderungen an Methodensignaturen der State-Autorität müssen an der Consumerstelle
einen Compilerfehler erzeugen. Der gebaute Browsergraph bleibt identisch im Verhalten, vollständig
im Manifest und in allen drei Engines lauffähig. Casts nur an echten untrusted Datenrändern,
jeweils nach Validierung.

### A15 — P2: Speicher- und Recovery-Verantwortung verteilt sich auf mehrere Transaktionswege

**Beleg:** [storage.ts](src/state/storage.ts), [authority.ts](src/state/authority.ts),
[backup.ts](src/state/backup.ts), [browser-reconciliation.ts](src/state/browser-reconciliation.ts).

Die aktuelle Implementierung muss Legacy-State, Authority-Envelope, Recovery-Sidecar,
Draft-/Journaldaten, Locks und Rollback-Lesbarkeit zusammendenken. Backup und Browser-Reconciliation
besitzen ähnliche eigene `readAuthority`-/`writeAuthority`-/Restore-Logik. A01 zeigt, dass
eine gemeinsame Invariante dabei zwischen den Wegen verloren gehen kann.

Die 2.195 Zeilen von `storage.ts` sind nicht als solche ein Fehler. Der Schutz vor konkurrierenden
Tabs und unterbrochenen Writes ist real. Problematisch ist, wenn mehrere Einstiegspunkte
abweichende Regeln für dieselbe logische Autorität pflegen.

**Vorschlag:** Nach A01/A02 eine Zustands- und Schreibpfadtabelle erstellen: Welche Schlüssel
existieren, wer schreibt sie, welche Vorgängerversion muss lesen können, welche Daten dürfen
wann verdrängt werden? Danach nur die gemeinsam benötigte Commit-/Conservation-Regel an
einer Stelle besitzen. Kein allgemeines Transaktionsframework und kein pauschaler Wechsel
auf IndexedDB ohne bewiesenen Bedarf.

**Abnahme:** Gleiche Failure-Injection-Fälle für Edit, Migration, Import, Clear und Restore;
bei unverändertem Fehler muss überall dieselbe Erhaltungsregel gelten. Die getesteten
Kompatibilitätsfälle definieren, welche Legacy-Pfade später tatsächlich entfallen dürfen.

### A16 — P2: Sehr große UI-Funktionen koppeln voneinander unabhängige Aufgaben

**Beleg:** [app.ts](src/site/app.ts), 1.859 Zeilen; `renderResults` mit 75 strukturellen
Entscheidungen; [docs/complexity-report.md](docs/complexity-report.md).

`renderResults` verwaltet Recovery, leere Ansichten, Fortschritt, Filterreaktionen, Hierarchie,
Disambiguierung, Research/Inactive, progressive Zeilen und Fokus. Dadurch führt ein kleiner
Anlass schnell zum Neuaufbau und zu Nebeneffekten in anderen Bereichen, sichtbar in A06/A07.

**Vorschlag:** Nach Behebung der Verhaltensfehler die vorhandenen natürlichen Grenzen nutzen:
abgeleitete Ergebnisdaten, Lebensdauer eines Ergebnisbereichs, Item-Zeile, Recovery-Werkzeuge,
kleiner Routenstart. Native Funktionen/Module reichen. Verantwortlichkeiten und Cleanupbesitz
sind wichtiger als eine willkürliche maximale Dateilänge.

**Abnahme:** Bestehende UI-Tests plus A05–A07 bleiben grün. Für eine reine Verschiebung keine
Tests schreiben, die lediglich neue private Funktionsnamen oder Dateigrenzen erzwingen.

### A17 — P3: Vollständige Datenmodule sind für Navigation und Erststart relativ groß

**Beleg:** erzeugtes Artefakt und Offline-Gzip-Messung mit Node/zlib.

| Modul                 |  Rohbytes | Gzip-Schätzung |
| --------------------- | --------: | -------------: |
| `snapshot.js`         | 3.170.355 |        267.181 |
| `migrations.js`       |   644.456 |        141.101 |
| `state/storage.js`    |    90.389 |         14.624 |
| `app.js`              |    75.199 |         16.787 |
| `collection-state.js` |    25.951 |          4.876 |

Die Querynavigation über native GET lädt die Collection-Dokumentinstanz neu. Browsercache
kann Transfer sparen, aber Parse-/Initialisierungsarbeit bleibt relevant. Die gesamten
Migrationen werden auch beim erstmaligen Besuch ohne private Daten geladen.

**Vorschlag:** Zuerst A09–A11 umsetzen und auf einem langsamen Gerät messen. Erst danach
prüfen, ob migrationsbezogene Arbeit sicher später stattfinden kann oder eine kleinere,
validierte Anzeigeprojektion sinnvoll ist. Das bestehende „vollständigen Tuple vor State-Zugriff
prüfen“ bleibt verbindlich. Nicht eigenmächtig Evidenzfelder oder historische Migrationswege
abschneiden und keine mutable Netzwerkquelle einführen.

**Abnahme:** Vorher/nachher Bytes, CPU und erste nutzbare Zeile messen; Ausfälle und alte
Browserzustände bleiben sicher. Ein semantisch neuer Producer-Vertrag benötigt das gepaarte
Issueverfahren, nicht bloß einen Verbraucher-Buildfilter.

### A18 — P3: Platzhalter bekommen unnötig eine vollständige Bildinteraktion

**Beleg:** [assets.ts](src/site/assets.ts) und [app.ts](src/site/app.ts),
`renderItemImage` ab Zeile 672.

Aktuell werden freigegebene authored placeholders verwendet. Trackbare Zeilen erzeugen
trotzdem Inspect-Button, Dialog, zweites Bild und Listener für eine Vergrößerung ohne zusätzliche
Karteninformation. Research-Zeilen sind bereits nicht interaktiv. Die wiederholten ausführlichen
Alternativtexte belasten außerdem die Ausgabe pro Karte.

**Vorschlag:** Einen Platzhalter knapp als solchen kennzeichnen und die Inspektion erst bei
einem wirklich verfügbaren, freigegebenen Bild aktivieren. Falls die bestehende Bildinspektion
als verpflichtendes Produktverhalten erhalten bleiben soll, reicht später ein gezielt geöffneter
Dialog statt einer vollständigen Dialoginstanz je Item. Native Dialogbedienung erhalten.

**Abnahme:** Kein unbegründeter Bildbezug; Research bleibt read-only; echte Bildinspektion hat
korrekten Scope, Tastaturbedienung und Fokusrückgabe. Keine fremden Kartenbilder als Audit-Fix
beschaffen oder veröffentlichen.

### A19 — P3: Viel Höhe vor der ersten Karte erschwert die tägliche Nutzung auf kleinen Displays

**Beleg:** gerenderte Screenshots und DOM-Messung der geprüften Ansicht bei 320 × 900 Pixeln,
Hell/Dunkel. Die erste Item-Zeile begann bei ungefähr **1.318 CSS-Pixeln** Dokumenthöhe.

Die Gestaltung ist konsistent: ruhige Farbflächen, selbst gehostete Typografie, klare Buttons
und nachvollziehbare Disclosures. Die wiederholte Einleitung, Provenienz, Suche, erweiterte
Filter, Navigation und Fortschrittsblöcke verbrauchen aber viel Platz vor der Hauptaufgabe.
In der gemessenen Ansicht war der zusätzliche Filterbereich aufgrund aktiver Kriterien offen.

**Vorschlag:** Auf Collection den Weg zu Karte/Status priorisieren. Längere Erklärungen in
bestehende Disclosures legen; aktive Filter knapp zusammenfassen; ausreichend große Controls
und sinnvolle Fokusreihenfolge bewahren. Keine permanente komplexe Sticky-Leiste ohne
Bedienmessung. Auf der Startseite darf die Einführung ausführlicher bleiben.

**Abnahme:** 320px, Vergrößerung, lange Namen, CJK-Fallbackfonts, beide Themes und geöffnete
Fehlerzustände visuell prüfen. Kürzere Strecke bis zur ersten Aktion darf keine Information
unzugänglich machen. Es gibt keinen in diesem Audit festgelegten universellen Pixelgrenzwert.

### A20 — P3: Sichtbare Provenienz ist hilfreich, aber nicht vollständig

**Beleg:** [app.ts](src/site/app.ts), `renderProvenance` ab Zeile 206.

Data-as-of, Producer-Revision, Contract, Fingerprint und Byte-Digest sind vorhanden. Die App-Revision
ist in Shell/Manifest gebunden, wird hier aber nicht angezeigt; Publikationsmetadaten sind
ebenfalls kein sichtbarer Teil dieser Übersicht. Das erschwert die Zuordnung eines Screenshots
oder Nutzerberichts zur genauen App-Version.

**Vorschlag:** Die ohnehin bekannte App-Revision und einen passenden öffentlichen
Veröffentlichungsnachweis knapp anbieten. Data-as-of und Published-at sprachlich unterscheiden.
Keine willkürliche „nach 30 Tagen veraltet“-Regel und keine zusätzliche mutable Laufzeitautorität
für den Katalog einführen. Publikationszeit bleibt außerhalb des deterministischen Katalogs.

**Abnahme:** Angezeigte Identität entspricht der Shell und dem veröffentlichten Manifest;
Fingerprint/Revision werden nicht aus Labels oder aktuellen Upstreamdaten abgeleitet.

### A21 — P2: Artifact-Checker trägt die Kosten eines eigenen HTML-Parsers

**Beleg:** [check-artifact.mjs](scripts/check-artifact.mjs), 997 Zeilen;
`extractHead` ab 541, `stripHtmlComments` ab 265, `readAttribute` ab 93.

Der Checker verarbeitet HTML-/Attribut-/Kommentarformen mit eigener umfangreicher Logik.
Seine Aufgaben sind sicherheitsrelevant; normale Textsuche ist für HTML-Ausführungsgrenzen
kein Ersatz für einen Parser. Die bereits vorhandenen Regressionen machen den bestehenden
Checker wertvoll, beweisen aber keine allgemeine Browserparser-Äquivalenz.

Es wurde hier **kein neuer HTML-Bypass nachgewiesen**. Dies ist ein Wartungs- und
Vertrauensgrenzenbefund, kein behaupteter Exploit. Die Regeln in AGENTS erlauben den bisherigen
heuristischen Umfang, verbieten jedoch neue syntaxabhängige Ausnahmen ohne Parsermigration.

Die Verifikation dieses Berichts hat zusätzlich einen reproduzierbaren Fehlalarm gezeigt:
`/[\s/]on[a-z]+\s*=/iu` wertet die Zeichenfolge `"/oNTY="` innerhalb eines generierten
SHA-256-SRI-Werts als Inline-Handler. Mit der synthetischen Merge-Revision
`1e5a71d2286d309ba0fb6e2914a21f3bc341f6c8` baut `build-site.mjs` genau diesen Digest;
`check-artifact.mjs` bricht danach für `index.html` mit `ARTIFACT_INLINE_HANDLER_PRESENT` ab,
während der Build desselben Quellstands mit der eigentlichen Head-Revision besteht. Der Fehler
belegt, dass die semantische HTML-Prüfung aktuell auch von zufälligen Digestzeichen abhängt.

**Vorschlag:** Vor weiterer semantischer Ausweitung ein owning Migration-Issue. HTML-Struktur
über einen geeigneten gepinnten Parser prüfen und die bereits gesammelten negativen Fixtures
behalten. Eine kleine, begründete Dev-Abhängigkeit kann weniger Gesamtrisiko verursachen als
ein wachsender eigener Parser. Nicht bloß weitere Regex-Ausnahmen ergänzen.

**Abnahme:** Vorhandene Manipulationsfixtures, Kommentare, doppelte Attribute, ungewöhnliche
Leerzeichen, Script-/Importmap-Grenzen, erste wirksame CSP und tatsächliche Browserausführung
prüfen. Lexikalische Canaries dürfen weiterhin einfache Tokenchecks bleiben.

### A22 — P3: Kritische MJS- und Workflowlogik liegt außerhalb der normalen Typprüfung

**Beleg:** [tsconfig.json](tsconfig.json) umfasst `*.ts`, aber keine `scripts/*.mjs`;
[deploy-pages.yml](.github/workflows/deploy-pages.yml) enthält zusätzlich umfangreiche
Inline-JavaScript-Validierung.

Ein wichtiger Teil von Runtime-Manifesterzeugung, Retention, Artifact-Prüfung und Releasekontrolle
wird dadurch nicht vom üblichen Typecheck erfasst. Der Komplexitätsbericht erfasst MJS im
`scripts/`-Verzeichnis, aber nicht JavaScript in YAML-Blöcken. Seine 13.076 Zeilen sind deshalb
kein vollständiges Maß der Produktionslogik.

**Vorschlag:** Beim nächsten verhaltensbezogenen Eingriff betreffende Inline-Guards in bestehende
testbare Skripte verschieben. Für kritische MJS-Dateien gezielt `checkJs`/JSDoc oder TypeScript
verwenden. Keine repositoryweite Sprachmigration als Vorbedingung kleiner Fehlerkorrekturen.

**Abnahme:** Eingaben aus Workflow-Env sind untrusted und werden validiert; negative Fälle
laufen als echte Programmausführung. Texttests dürfen Verdrahtung prüfen, aber nicht allein
die Semantik eines Deploymentguards beweisen.

### A23 — P3: Sicherheitsrelevante Hilfslogik und Typen werden mehrfach gepflegt

**Beleg:** Kanonisierung in [app.ts](src/site/app.ts), [directory.ts](src/site/directory.ts)
und [catalogue.ts](src/site/catalogue.ts), außerdem Node-seitige Katalogvalidierung;
gespiegelte Zustands-/Resulttypen aus A14.

Nicht jede doppelte Zeile ist unnötig: Node- und Browserprüfungen schützen unterschiedliche
Grenzen; Directory-Envelope-Digest, semantischer Katalogfingerprint und Bytehash haben
unterschiedliche Eingaben. Ihre Gleichsetzung wäre ein Fehler. Die deterministische
Sortier-/Serialisierungsregel sollte aber nicht versehentlich auseinanderlaufen.

**Vorschlag:** Nur nach klarer Input-/Output-Tabelle die tatsächlich gleiche reine Regel teilen.
Die jeweilige Digest-Hülle und ihre Validierung ausdrücklich getrennt lassen. Gemeinsame
Testvektoren für Unicode, null, Arrays und Schlüsselreihenfolge sind sinnvoller als ein
generisches Hash-Framework mit vielen Modi.

**Abnahme:** Bereits akzeptierte Fingerprints und Directory-Digests bleiben gleich; geänderte
Publikationsmetadaten ändern nur die dafür vorgesehene Hülle. Keine semantische Änderung
unter dem Etikett „Refactoring“ verstecken.

### A24 — P3: Wiederholte Builds in CI verursachen vermeidbare Arbeit

**Beleg:** [package.json](package.json), [ci.yml](.github/workflows/ci.yml).

Der Browserjob baut die Site, führt Browserprüfungen aus und ruft dann `test:accessibility` auf,
das dieselbe Site nochmals baut. `npm run check` enthält zusätzlich einen normalen Build und
zwei Builds zur Reproduzierbarkeit. Letzteres hat einen begründeten Prüfzweck; der weitere
Build vor Accessibility im selben unveränderten Job ist dagegen ein Kandidat zum Einsparen.
Push- und PR-Trigger können zudem für denselben Branchcommit getrennte Läufe erzeugen.

**Vorschlag:** Einen nachweislich identischen Build innerhalb des Browserjobs für beide Suites
verwenden, etwa über getrennte Build-/Run-Kommandos. Triggerdopplungen erst nach Messung der
tatsächlichen CI-Zeiten und Prüfung der Branchregeln ändern. Der Schutz vor ungeprüften
Deployments und die Linux-/Windows-Reproduzierbarkeit bleiben bestehen.

**Abnahme:** Browser- und Accessibility-Prüfung verwenden dieselbe Revision und dasselbe Artefakt;
fehlendes oder veraltetes Artefakt wird erkannt. Einsparung anhand von Laufzeit/Buildanzahl
berichten. Keine behauptete Kostenersparnis ohne Messung.

### A25 — P3: Einige Versions- und Kompatibilitätsgrenzen benötigen klare Endbedingungen

**Beleg:** [runtime-assets.mjs](scripts/runtime-assets.mjs),
[retain-runtime-assets.mjs](scripts/retain-runtime-assets.mjs),
[build-site.mjs](scripts/build-site.mjs), Workflow-Actionreferenzen.

- Legacy-Modulpfade werden neben revisionsgebundenen Modulen ausgeliefert. Das ist aus der
  konkreten Rollbackhistorie begründet, erhöht aber Artefaktgröße und Prüfaufwand.
- CSS wird unter einem stabilen `styles.css`-Pfad veröffentlicht, während ausführbare Module
  revisionsgebunden sind. Ein alter gecachter HTML-/JS-Stand kann somit neuere Styles erhalten.
  Eine konkrete schädliche Layoutmischung wurde hier nicht reproduziert.
- Npm-Pakete sind exakt gepinnt; GitHub Actions verwenden teilweise bewegliche Major-Tags
  wie `actions/checkout@v7`. Dependabot ist vorhanden.

**Vorschlag:** Für Legacy-Dateien ein dokumentiertes unterstütztes Vorgängerfenster und
Löschkriterium festlegen. CSS bei zukünftigen inkompatiblen Layoutänderungen in die
Revisionskohärenz einbeziehen. Action-SHAs mit automatisierten Aktualisierungsvorschlägen
prüfen. Dies sind drei begrenzte Maßnahmen, keine Aufforderung zu einer neuen Releaseplattform.

**Abnahme:** Die deklarierte Rollbackgeneration bleibt vollständig nutzbar; alte/neue Styles
werden entweder kompatibel gehalten oder eindeutig gebunden. Keine Legacy-Datei allein
aufgrund einer scheinbar fehlenden aktuellen Importreferenz löschen.

### A26 — P2: Tests decken viele Einzelränder ab, aber einige wichtige Nutzungsketten fehlen

**Beleg:** Alle ausgeführten Gates sind grün; A01, A02 und A05–A07 sind dennoch reproduzierbar.
Das ist eine konkrete Lücke zwischen vorhandener Testbreite und relevanten Lebenszyklen.

Besonders fehlen als dauerhafte Regressionen:

1. Mehrere aufeinanderfolgende Katalogwechsel mit schon vorher ausgeschiedenen Records.
2. Wiederherstellung aus gültigem Backup bei beschädigtem bestehenden Storage.
3. Erste Bearbeitung → sofortiger Export ohne Reload.
4. Bearbeitung → Ergebnis fällt aus Statusfilter → sinnvolle Tastaturfortsetzung.
5. Details öffnen → weitere Ergebnisse anzeigen → bisheriger Bedienzustand bleibt bestehen.
6. Bekannte Produktion → Manifest fehlt → kein ungeprüfter Bootstrap.

**Vorschlag:** Diese Sequenzen direkt bei den jeweiligen Fixes ergänzen. Eine Boundary-Suite
soll die tatsächliche zuständige Funktion oder das Skript ausführen; UI-Sequenzen in den
bestehenden Browser-Smokes prüfen. Keine neue Testplattform und kein umfassendes
Snapshot-Testsystem einführen.

**Abnahme:** Jeder neue Test scheitert am hier geprüften Stand aus dem beabsichtigten Grund
und besteht mit dem kleinsten Fix. Tests müssen die Invariante prüfen, nicht den Wortlaut
eines internen Kommentars. Ein hoher Testzähler allein ist keine Abschlussbedingung.

### A27 — P3: Der Einstieg für neue Agenten enthält überholte Statuszusammenfassungen

**Beleg:** #2 ist nach späteren Kommentaren abgeschlossen, sein Body enthält aber unter anderem
einen alten akzeptierten Fingerprint, „Next action #6“, zahlreiche offene Phasencheckboxen und
einen Fortschrittsblock „IN PROGRESS“ vom 30. August. Die ausführliche Kommentarhistorie klärt
das auf, kostet beim frischen Einstieg aber erheblich Zeit.

Auch die vielen Stabilitätsdokumente sind nützlich, wiederholen teilweise dieselben Grenzen.
Die Gefahr ist nicht die Dateizahl selbst, sondern mehrere ähnlich autoritativ wirkende
Aussagen mit unterschiedlichem Stand.

**Vorschlag:** Im jeweils owning Issue die oberste Zusammenfassung auf den tatsächlichen
Terminalzustand bringen, frühe Werte ausdrücklich als historischen Baselinezustand markieren
und zur aktuellen veröffentlichten Identität verlinken. Stabile Regeln nur an einer
kanonischen Stelle ausführlich beschreiben, anderswo gezielt darauf verweisen.

**Abnahme:** Ein neuer Agent kann aktuellen Status, Produktumfang, gültigen Lock und offene
Folgearbeit ohne Rekonstruktion von PR-Threads identifizieren. Historische Evidenz nicht löschen
oder nachträglich in eine andere Aussage umschreiben. Dieser Bericht eröffnet selbst keine
Issues und ändert keine externe Kommunikation.

## 5. Komplexität richtig bewerten

Die vorhandene gepinnte TypeScript-AST-Auswertung wurde verwendet; es wurde kein neuer
syntaxabhängiger Regex-Analysator gebaut. Der Report umfasst `src/` und `scripts/`:

| Kennzahl                                     |    Wert |
| -------------------------------------------- | ------: |
| Produktionsdateien                           |      37 |
| Zeilen                                       |  13.076 |
| Funktionsartige AST-Knoten                   |     807 |
| Summe geschätzter zyklomatischer Komplexität |   3.748 |
| Mittelwert / Median                          | 4,6 / 2 |
| P90 / P95                                    | 10 / 18 |
| Funktionen über 10 / über 20                 | 75 / 37 |

| Hotspot                                                            | Komplexität | Sinnvoller Ansatz                                                              |
| ------------------------------------------------------------------ | ----------: | ------------------------------------------------------------------------------ |
| `src/site/catalogue.ts:223 validateSnapshot`                       |          90 | Trust-Boundary-Felder nach echten Vertragsabschnitten ordnen; Prüfung erhalten |
| `src/site/app.ts:1348 renderResults`                               |          75 | DOM-Lebensdauer und Ergebnisableitung trennen; A06/A07/A16                     |
| `src/state/storage.ts:705 persistPendingNoteDraft`                 |          75 | Zustandsübergänge und Failure-Fälle zuerst tabellieren                         |
| `src/state/reconciliation.ts:515 reconcilePrivateState`            |          58 | Conservation über mehrere Generationen absichern; keine Mapping-Heuristik      |
| `src/catalogue/validate.ts:235 validateSemantics`                  |          56 | Autoritätsgruppen und negative Fixtures nachvollziehbar halten                 |
| `src/catalogue/validate.ts:416 validateCatalogueFixture`           |          54 | Pflichtfälle explizit lassen; keine Reduktion bloß für Kennzahl                |
| `scripts/catalogue-release.mjs:127 createCatalogueReleaseManifest` |          50 | Veröffentlichungsidentität, Inputprüfung und Ausgabe als klare Schritte        |
| `scripts/check-artifact.mjs:541 extractHead`                       |          45 | Parsermigration an semantischer Grenze; A21                                    |
| `src/site/deployment.ts:38 validatePagesDeployment`                |          40 | Deklarierte Rollbackmatrix und Identitätsprüfung explizit halten               |

Die Metrik zählt auch logische Verknüpfungen. Viele prüfbare Vertragsbedingungen erzeugen
deshalb hohe Werte, ohne dass die Funktion langsam sein muss. Umgekehrt kann eine kurze
verschachtelte Schleife teuer sein. **Zyklomatische Komplexität, Laufzeitkomplexität, Codeumfang
und kognitive Last sind verschiedene Größen.**

#51 hat eine beratende Baseline akzeptiert, keinen absoluten Freigabeschwellwert. Das
`complexity:check`-Kommando prüft die Aktualität dieser Baseline; es bedeutet nicht, dass jede
Funktion unter einer Qualitätsgrenze liegt. Luna soll weder nachträglich einen Grenzwert
erfinden noch Bedingungen in Einzeiler-Helfer verschieben, um die Zahlen kosmetisch zu senken.

Praktische Reihenfolge bei einem Hotspot:

1. Betroffene Invariante und reproduzierbares Problem benennen.
2. Datenfluss/Seiteneffekte aufschreiben; zuständige Autorität festhalten.
3. Kleinsten Regressionstest für den Fehler herstellen.
4. Doppelte Arbeit oder doppelte Verantwortung entfernen.
5. Verhalten, Datenbilanz und gegebenenfalls Laufzeit vorher/nachher vergleichen.
6. AST-Bericht über sein vorgesehenes Kommando aktualisieren, nicht von Hand.

## 6. Verbindliche Leitplanken für Luna Max

Diese Leitplanken konkretisieren den Auditauftrag; die kanonischen Projektregeln in
[AGENTS.md](AGENTS.md) bleiben maßgeblich.

1. **Keine pauschale Neuimplementierung.** Pro Issue ein klarer Verhaltensschritt. Den hier
   geprüften Commit mit dem tatsächlichen neuen Arbeitsstand vergleichen, bevor ein Befund
   umgesetzt wird.
2. **Datenverlust zuerst.** Bis A01 geklärt ist, keine neue erfolgreiche Mehrgenerationenmigration
   behaupten. Alte Recovery-Daten gehören in die Erhaltungsbilanz.
3. **Zustand nicht erraten.** Nur ausdrücklich sichere identitätserhaltende 1:1-Migrationen
   automatisch anwenden. 1:N, N:1, Retirement und Konflikt benötigen Erhaltung und eindeutige
   Behandlung, keine Kopier-/Mergeheuristik.
4. **Ein Recovery-Fehler ist keine leere Sammlung.** Unlesbare Bestände nicht durch Defaults
   überschreiben. Aktive Daten, historische Daten und ungespeicherte Drafts sprachlich und
   technisch unterscheiden.
5. **Producer bleibt Wahrheitsquelle.** Locality, IDs, Work-Beziehungen, Edition, Finish,
   Evidenz und Migrationen ausschließlich aus dem akzeptierten öffentlichen Vertrag verwenden.
   `null`/omitted/candidate ist keine Nichtexistenzaussage.
6. **Private Testdaten synthetisch halten.** Keine echten Browserprofile oder Exporte für
   Reproduktionen verwenden. Keine privaten Werte in Logs, URLs, Snapshots, Screenshots,
   öffentlichen Issues oder Commitdateien.
7. **Keine Fremdzugriffe ergänzen.** Kein Backend, Login, Analytics, Runtime-Upstream-Fetch,
   Service Worker, Cloudspeicher oder Bildscraping als Nebenprodukt des Audits.
8. **Native Werkzeuge bevorzugen.** DOM, Maps, Sets, `Intl.Collator`, bestehende Module und
   Compiler nutzen. Eine neue Abhängigkeit nur gegen tatsächlich entfernte Komplexität
   begründen; ein Parser kann an der richtigen Grenze sinnvoll sein.
9. **Kein Vertrauen durch Casts.** Echte unbekannte Eingaben validieren; eigene APIs direkt
   typisieren. Gemeinsame Sicherheitslogik nur bei nachweislich gleichen Eingaben teilen.
10. **Unveränderte Zeilen bleiben unverändert.** Batch-Benachrichtigungen, begrenzte DOM-Updates
    und klare Cleanup-Verantwortung. Keine globale Sortierung für jede Notizänderung.
11. **Bedienbarkeit mitprüfen.** Fokusnachfolger, Statusankündigungen, Drafts, geöffnete Details,
    kleine Displays und beide Themes sind Teil der Funktion, keine Abschlussdekoration.
12. **Schutzprüfungen nicht für Performance entfernen.** Validierung, Readback, Locks und
    Revisionsbindung nur anhand einer nachgewiesen gleichwertigen Alternative ändern.
13. **Semantische Quellanalyse über den gepinnten Parser.** Keine Erweiterung alter heuristischer
    Syntaxscanner durch weitere Sonderfälle; zuerst owning Migration-Issue.
14. **Kompatibilität begrenzen, nicht vergessen.** Unterstützte alte State-/Runtime-Versionen
    explizit festhalten. Dateien oder Parserpfade erst nach Ende des belegten Fensters entfernen.
15. **Veröffentlichung bleibt eigener Schritt.** Merge ist keine Katalogabnahme. Änderungen an
    gemeinsamem Vertrag, IDs, Migration oder Rollout vorher in den zuständigen gepaarten Issues
    festhalten. Aktiven und Rollback-Tuple vor/nach Veröffentlichung prüfen.
16. **Abnahme am Verhalten.** Ein reproduzierbarer Fehler benötigt einen Regressionstest.
    Keine flakigen festen Zeitgrenzen und keine Tests, die lediglich interne Implementierung
    spiegeln. Bestehende Pflichtgates vor PR/Deployment vollständig ausführen.
17. **Kommunikation und Umsetzung nicht aus diesem Bericht ableiten, wenn sie noch nicht
    autorisiert sind.** Dieser Auditauftrag selbst autorisiert keine externen Kommentare,
    Freigaben, Merges oder Deployments. Der folgende Umsetzungsauftrag bestimmt die Handlungen.

## 7. Empfohlene Umsetzungsreihenfolge

Die Pakete werden im Master-Issue [#89](https://github.com/m4s-ai/snoredex-checklist/issues/89)
und den verknüpften Issues #90–#101 verfolgt. Abhängigkeiten, aktueller Status und veränderliche
Abnahmeentscheidungen gehören in diesen GitHub-Graphen. Vor Implementierung die konkrete
Reproduktion am dann aktuellen Stand bestätigen. Kein großes Sammel-PR.

| Reihenfolge |                                                    Owning Issue | Zugeordnete Befunde          | Konkretes Ende                                                                           |
| ----------: | --------------------------------------------------------------: | ---------------------------- | ---------------------------------------------------------------------------------------- |
|           1 |   [#90](https://github.com/m4s-ai/snoredex-checklist/issues/90) | A01, relevanter Teil A15/A26 | Reproduktion verliert keine Daten mehr; unsichere Rotation blockiert sicher              |
|           2 |   [#91](https://github.com/m4s-ai/snoredex-checklist/issues/91) | A02, A15/A26                 | Gültiges Backup kann mit Erhaltung der Originale bestätigt übernommen werden             |
|           3 |   [#92](https://github.com/m4s-ai/snoredex-checklist/issues/92) | A04                          | 404 einer bestehenden Produktion stoppt vor Veröffentlichung                             |
|           4 |   [#93](https://github.com/m4s-ai/snoredex-checklist/issues/93) | A05/A06                      | Erste Speicherung exportierbar; Filterwechsel hält sinnvollen Fokus                      |
|           5 |   [#94](https://github.com/m4s-ai/snoredex-checklist/issues/94) | A03                          | Edition/Größe/Seltenheit/Klasse passend erkennbar, ohne Inferenz                         |
|           6 |   [#95](https://github.com/m4s-ai/snoredex-checklist/issues/95) | A08/A12                      | Explizite akzeptierte Sollbeschreibung; Voraussetzungen für nächsten Katalogwechsel klar |
|           7 |   [#96](https://github.com/m4s-ai/snoredex-checklist/issues/96) | A09                          | Unveränderte Records lösen keine globale Wiederaufbereitung aus                          |
|           8 |   [#97](https://github.com/m4s-ai/snoredex-checklist/issues/97) | A07/A10/A16                  | Neue Zeilen werden ergänzt; Ergebnisdaten einmal abgeleitet                              |
|           9 |   [#98](https://github.com/m4s-ai/snoredex-checklist/issues/98) | A11/A14                      | Kleine Homepage; compilergeprüfte Site-/State-APIs                                       |
|          10 |   [#99](https://github.com/m4s-ai/snoredex-checklist/issues/99) | A13/A18/A19/A20              | Ehrliche Recovery-/Fehlertexte, kürzerer Weg zur Karte                                   |
|          11 | [#100](https://github.com/m4s-ai/snoredex-checklist/issues/100) | A21–A25/A27                  | Echte Duplikate entfernt, bestehende Sicherheits- und Rollbackbeweise erhalten           |
|          12 | [#101](https://github.com/m4s-ai/snoredex-checklist/issues/101) | A17                          | Belegte Verbesserung auf langsamem Gerät ohne Vertragsverlust                            |

Für jedes Paket sollte Luna knapp berichten: auslösendes Szenario, Änderung und warum sie
ausreicht, Regression vor/nachher, verbleibende Grenze und betroffene Autorität. Das Ziel ist
eine besser benutzbare und sicherere Checkliste, keine möglichst umfangreiche Refactoringliste.

## 8. Ausführbare Minimalreproduktion des schwersten Fehlers

Das folgende Programm kann mit der gepinnten Node-Version als temporäre `.mjs`-Datei **außerhalb
des Repositorys** gespeichert und aus dem Repository-Arbeitsverzeichnis gestartet werden.
Es benutzt ausschließlich erfundene IDs, Fingerprints und einen In-Memory-Storage. Es schreibt
keine echte Exportdatei und öffnet kein Browserprofil. Die letzte Assertion soll am geprüften
Stand scheitern und nach dem Fix bestehen. Andere mögliche Globals in einem fremden Testprozess
werden nicht vorausgesetzt; das Programm ist für einen eigenen Node-Prozess gedacht.

```javascript
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve('src/state/browser-reconciliation.ts')).href;
const { reconcileBrowserState } = await import(moduleUrl);

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const X = 'item-10000000-0000-5000-8000-000000000001';
const Y = 'item-10000000-0000-5000-8000-000000000002';
const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
  key: (index) => [...values.keys()][index] ?? null,
  get length() {
    return values.size;
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: { request: async (_name, callback) => callback() } },
});

storage.setItem(
  'snoredex-checklist.private-state',
  JSON.stringify({
    schema: 'snoredex-collection-state',
    schemaVersion: '1.0.0',
    datasetId: 'snoredex-data/snorlax-current-known',
    catalogueFingerprint: A,
    items: [X, Y].map((itemId) => ({
      itemId,
      status: 'have',
      quantityOwned: 1,
      quantityOrdered: 0,
    })),
  }),
);

const retained = (id) => ({
  fromItemId: id,
  toItemIds: [id],
  changeKind: 'retained',
  automaticStateAction: 'preserve',
  reconciliation: 'identity-retained',
});
const context = (fromFingerprint, toFingerprint, sourceIds, transitions) => ({
  knownSourceItemIds: new Set(sourceIds),
  targetItemClasses: new Map([[Y, 'current-known']]),
  migrations: [{ fromFingerprint, toFingerprint, transitions }],
});
const containsX = () => [...values.values()].some((raw) => raw.includes(X));

const first = await reconcileBrowserState(
  B,
  new Set([Y]),
  context(
    A,
    B,
    [X, Y],
    [
      {
        fromItemId: X,
        toItemIds: [],
        changeKind: 'retired-1:0',
        automaticStateAction: 'none',
        reconciliation: 'retire-to-orphan',
      },
      retained(Y),
    ],
  ),
);
assert.equal(first.ok, true);
assert.equal(containsX(), true);

const second = await reconcileBrowserState(C, new Set([Y]), context(B, C, [Y], [retained(Y)]));
console.log({ first, second, originalRecordStillPreserved: containsX() });
assert.equal(containsX(), true, 'Ein späterer Übergang darf den einzigen erhaltenen Record X nicht entfernen');
```

Ein sicher blockierter zweiter Übergang wäre für den ersten begrenzten Fix zulässig.
Eine spätere vollständige Lösung soll beide Übergänge unterstützen und X trotzdem dauerhaft
nachvollziehbar erhalten. Der Smoke sucht hier nur die synthetische ID; der endgültige
Regressionstest muss zusätzlich Status, Mengen, Notizen, Fingerprint und Exportierbarkeit
fachlich prüfen.

## 9. Abschlusskriterien für die spätere Umsetzung

Die nächste Qualitätsabnahme sollte nicht allein auf einem grünen Gesamtlauf oder geschlossenen
Issues beruhen. Für diesen Bericht sind folgende Ergebnisse entscheidend:

- Kein Verlust historischer expliziter Records über mehrere Kataloggenerationen und
  wiederholte Import-/Clear-/Restore-Vorgänge.
- Ein gültiges Backup bietet bei beschädigtem Istzustand einen tatsächlich funktionierenden,
  bestätigten und originalerhaltenden Wiederherstellungsweg.
- Fehlende Produktionsautorität kann nicht still zum Erststart werden.
- Physisch unterschiedliche Items sind über gelieferte Merkmale verständlich identifizierbar.
- Fortschrittsumfang und unterstützte Rollbackfälle sind ausdrücklich entschieden und
  stimmen mit der sichtbaren Oberfläche beziehungsweise dem Workflow überein.
- Erste Speicherung, Export, Statusfilter und progressive Darstellung funktionieren in einer
  zusammenhängenden Sitzung ohne Reload-Workarounds oder verlorenen Fokus.
- Performanceverbesserungen entfernen nachgewiesene Mehrfacharbeit; State- und Vertrauensgrenzen
  bleiben vollständig erhalten.
- Vollständige Repository-, Vertrags-, Browser- und Accessibility-Gates bestehen am endgültigen
  Stand; erforderliche manuelle Bedienprüfungen sind für diesen Stand dokumentiert.
- Nur nach tatsächlicher Veröffentlichung wird die genaue Producer-/Consumer-Identität
  erneut end-to-end als VERIFIED bezeichnet.

**Auditabschluss:** Die vorhandenen Gates und der lesende Live-Smoke bestehen. Die oben
beschriebenen Fehler und Lücken sind damit nicht erledigt. In diesem Auftrag wurden sie
untersucht und dokumentiert; ihre Umsetzung bleibt bei 5.6 Luna Max.
