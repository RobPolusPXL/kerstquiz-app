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

Alles staat in `questions.json` (3 rondes). Pas aan en klik in `/admin` op "Vragen herladen".
Vraagtypes: `choice`, `text`, `number`. Rondemodi: `paced` (eigen tempo, timer) en `buzzer` (live).
Afbeeldingen: zet ze in `public/media/` en verwijs met `"image": "/media/foto.jpg"`.
Geef vragen een vaste `id` als je ze nog herordent nadat het spel gestart is.

## Hosten

Draait overal waar Node 18+ draait (bv. Render/Fly/Railway). Start command: `npm start`,
env: `ADMIN_PASSWORD`. Spelstatus wordt bewaard in `data/state.json` (zet `DATA_DIR` op een
persistente schijf als je zeker wil zijn dat die een herstart overleeft).

## Test

`npm test` start de server en simuleert moderator + spelers (antwoorden, scoring, buzzer, reconnect).
