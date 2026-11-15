# Shelf Life

A quiet reading tracker for physical books. Log the page you're on, see your pace and estimated finish date, jot down notes as you read, and look back on your reading year.

## Features

- **Home:** your yearly goal and whether you're ahead or behind pace, your reading streak, the books you're reading now with a quick "Update page" button, and your shelf drawn as book spines (filter by Reading, To read and Finished).
- **Book page:** current page, pages per day, estimated finish date, pages to go, and a chart of the last 14 days. Below that is a running list of notes, each tagged with the page and date. Rate books when you finish them.
- **Add a book:** a short form. Only the title and page count are required. The status (To read, Reading or Finished) decides which other fields appear, and the cover colour previews as you type.
- **Insights:** books finished, pages read, reading days and average rating, compared with the previous year. It also has pages per month, a reading-days heatmap, which weekdays you read most, genres, and records like fastest read and biggest day. Switch between years or see all time.
- **Backup:** export your books to a JSON file and import it on another device or browser.

## Running it

No build step and no dependencies. It's three files: `index.html`, `styles.css` and `app.js`.

- Open `index.html` in a browser, or
- serve the folder locally with something like `npx serve .` or `python3 -m http.server`, or
- publish it with GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).

## Your data

Everything is saved in your browser's `localStorage` under the key `shelf-life:v1`. Nothing leaves your device. Data is per browser and per device, so use **Export my books** at the bottom of the home screen to back it up or move it. Clearing your browser's site data erases it.

## Design

- Type: Fraunces (display), Figtree (text) and Fragment Mono (figures), from Google Fonts
- Colour: a "Brick" accent on warm neutrals, with a matching dark theme that follows your system setting
