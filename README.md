# Kerstquiz

Live kerstquiz-webapp: spelers doen mee op hun gsm onder hun eigen naam, de moderator ziet en bestuurt alles.

- Spelers: `/` (naam kiezen, vragen beantwoorden, buzzer)
- Moderator: `/admin` (wachtwoord)
- Tv/beamer: `/tv` (lobby, timer, buzzer, scorebord)

## Starten

```bash
npm install
ADMIN_PASSWORD=iets-geheims npm start     # http://localhost:3000
```

Zonder `ADMIN_PASSWORD` wordt een tijdelijk wachtwoord in de console getoond.
Op één wifi spelen: spelers openen `http://<ip-van-je-laptop>:3000`.

## Vragen

Elk jaar heeft een eigen bestand: `quizzes/<jaar>.json` (3 rondes). Het hoogste jaar is actief, of zet `QUIZ_YEAR=2026`.
Pas aan en klik in `/admin` op "Vragen herladen". `quizzes/2025.json` is een archief (`"archief": true`): daar wordt geen stand van bewaard.
Per jaar heeft de spelstatus een eigen bestand (`data/state-<jaar>.json`) en wordt de stand bewaard in `data/standings-<jaar>.json`.
De algemene ranking over alle jaren staat op `/ranking` (opgebouwd uit die standen, spelers worden op naam samengevoegd).
Vraagtypes: `choice`, `text`, `number`. Rondemodi: `stepped` (vraag per vraag, jij start elke vraag, `seconds` = timer per vraag),
`buzzer` (live) en `paced` (alle vragen tegelijk op eigen tempo binnen `minutes`).
Afbeeldingen: zet ze in `public/media/` en verwijs met `"image": "/media/foto.jpg"`.
Geef vragen een vaste `id` als je ze nog herordent nadat het spel gestart is.

## Buzzer

Bij "Open buzzer" plant de server het openingstijdstip 1,5 s later (`BUZZ_LEAD_MS` om dat te wijzigen). Alle gsm's tonen "KLAAR…" en gaan op exact dat moment samen open; drukken vóór die tijd telt niet.

## Hosten

Draait overal waar Node 18+ draait (bv. Render/Fly/Railway). Start command: `npm start`,
env: `ADMIN_PASSWORD`. Spelstatus wordt bewaard in `data/state-<jaar>.json` (zet `DATA_DIR` op een
persistente schijf (ook de standen per jaar staan daar, dus zonder blijft de ranking niet bewaard) als je zeker wil zijn dat die een herstart overleeft).

## Test

`npm test` start de server en simuleert moderator + spelers (antwoorden, scoring, buzzer, reconnect).
