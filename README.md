# Glimt

En snygg docka för Windows 11 som kan ersätta aktivitetsfältet. Glimt samlar dina appar, en mediaspelare, systemstatus, sök och ett kontrollcenter i en flytande glasdocka längst ner på skärmen.

Inspirerad av Lumabar, men all kod är skriven från grunden.

## Funktioner

- **Docka med appar:** fästa appar och öppna fönster med markering. Klick växlar och minimerar som i vanliga aktivitetsfältet.
- **Mediaspelare:** styr Spotify, webbläsare och andra spelare som syns i Windows mediakontroller. Visar omslag, tidslinje, shuffle, repeat och volym, och färgar spelaren efter omslaget.
- **Systemwidgets:** CPU (med graf och de tyngsta processerna), RAM, nätverk, disk, batteri, väder (Open-Meteo, ingen API-nyckel behövs) och klocka.
- **Sök (Win+S, Alt+Mellanslag eller sökknappen):** en Spotlight-liknande sökruta i glas. Söker bland appar, filer (Windows sökindex) och inställningar, och fungerar som miniräknare.
- **Kontrollcenter:**
  - Bluetooth, Wi-Fi och mikrofon av/på
  - skärminställningar, avstängning och omstart
  - val av ljudutgång, huvudvolym och volym per app
  - Epic Games-kontobytare
- **Ersätt aktivitetsfältet:** döljer Windows aktivitetsfält och reserverar dockans plats på skärmen. Om Glimt kraschar återställs aktivitetsfältet automatiskt.
- **Inställningar:**
  - lägg till, ta bort och sortera widgets
  - tema, accentfärg, täckning, oskärpa, hörnradie, storlek och placering
  - starta med Windows

## Installera

Ladda ner `Glimt Setup x.y.z.exe` från [Releases](../../releases) och kör den. Glimt installeras för din användare, så du behöver inte vara administratör. Sedan startar Glimt automatiskt när du loggar in.

Windows SmartScreen kan varna eftersom installationsfilen inte är signerad. Välj **Mer information → Kör ändå**.

### Ersätta aktivitetsfältet

1. Slå på **Ersätt aktivitetsfältet** under *Inställningar → Allmänt* i Glimt.
2. Slå på **Dölj aktivitetsfältet automatiskt** i Windows (*Inställningar → Anpassning → Aktivitetsfältet*). Glimt visar en knapp dit.

## Bygga från källkod

Krav: Windows 10/11 och [Node.js](https://nodejs.org) 20 eller senare.

```bash
npm install
npm start            # kör Glimt direkt
npm run dist         # bygger installationsfilen till dist/
```

Om `npm start` klagar på att Electron saknas (nyare npm kör inte installationsskript automatiskt) kör du:

```bash
node node_modules/electron/install.js
```

## Hur det fungerar

| Del | Fil | Vad den gör |
| --- | --- | --- |
| Huvudprocess | `main.js` | Fönster, inställningar, autostart (Schemaläggaren), väder, app-index, Epic-kontobyte |
| Docka och sök | `src/dock.*` | Widgets, popover-paneler, kontrollcenter, sökrutan |
| Inställningar | `src/settings.*` | Inställningsfönstret |
| Windows-hjälpare | `helper/glimt-helper.ps1` | PowerShell + C# som pratar med Windows: mediasessioner, volym och mixer, fönsterlista, aktivitetsfältet, Bluetooth/Wi-Fi, filsök, glaseffekt |
| Tangentbordskrok | `helper/glimt-keys.ps1` | Fångar Win+S så att Glimts sök öppnas |
| Vakthund | `helper/glimt-watchdog.ps1` | Visar aktivitetsfältet igen om Glimt kraschar |

Hjälparen och Glimt pratar med varandra via JSON-rader på stdin/stdout.

## Integritet

- Inställningar och logg sparas lokalt i `%APPDATA%\Glimt`.
- Epic-kontobytaren sparar Epics inloggning för varje konto i `%APPDATA%\Glimt\epic`, bara på din dator. Byt konto via Glimt i stället för att logga ut i Epic: att logga ut gör den sparade inloggningen ogiltig.
- Det enda nätverksanropet Glimt gör är till Open-Meteo för vädret.
