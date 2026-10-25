# Grabble Checker

A phone app for settling arguments in **Grabble**, the Scrabble-tile game where everyone flips tiles face up one at a time and grabs words as they spot them.

Point your camera at a row of tiles and it tells you whether the word is valid. You can also type a word in.

- **Always live:** the camera reads the tiles continuously and the result appears in the panel underneath as soon as two reads agree. There's no shutter to press. Tap **Hold** to freeze a reading, and **Resume** to carry on. You can also pick a photo from your gallery.
- **Same layout for typing:** the Type tab uses the same result panel, updating as you type.
- **Fix misreads:** tap the tiles to correct a letter. If a scan isn't a word but a lookalike letter would make one (E/F, C/G, O/Q…), it suggests that word. It never swaps one in for you.
- **Same-letter words:** when a word isn't valid, it lists valid words that use exactly the same letters.
- **Full-screen verdict:** a big green ✓ or red ✗ you can turn round and show the table. Tap the expand icon on any result, or turn it on in Settings to show it whenever you hold a reading or pick a photo.
- **Sounds and vibration:** a chime for valid words and a buzz for invalid ones. Sounds can be turned off in Settings.
- **Definitions when online:** valid words show their meaning, looked up from the Free Dictionary API with Wiktionary as a fallback. Recent look-ups are kept on the device.
- **Save the photo:** under "What the scanner saw" you can save the original scan, so misreads can be sent in and used to tune the scanner.
- **Count tiles at the end of a game:** switch the Scan screen to **Count tiles** and point the camera at a player's tiles. It reads several rows at once and shows the number of tiles and their total points. Add each batch to the **tally**, add any blanks (the scanner can't see them), then save the tally as that player's score. The **Scores** list ranks everyone by tiles, then points.
- **History** of everything you've checked, plus a **minimum word length** setting (default 3).
- **Installable PWA** that works fully offline after the first visit, including the scanner.

## How the scanner works

Tesseract has trouble with a raw photo of tiles: it reads the little point numbers, tile edges and table texture as letters. So `js/ocr.js` finds the letters itself first:

1. It applies an adaptive threshold, then finds connected blobs.
2. It keeps only blobs that look like printed letters. That means high contrast against their surroundings, thick strokes, and the dominant letter height. This drops the point digits, which are about a third of the letter height, along with tile outlines and wood or carpet texture.
3. It fits a line through the letters. If the row is tilted, it rotates the image straight and looks again.
4. It redraws the letters as clean black-on-white glyphs in one evenly spaced row, and Tesseract reads that row with an A–Z whitelist. If the count doesn't match, it reads each letter on its own. A solid narrow bar is treated as an `I`.

If you want to see what the scanner saw, open "What the scanner saw" on the result sheet.

## Dictionary

The built-in word list is **ENABLE** (172,823 words, public domain). It's close to the North American tournament list. To use a different list, such as Collins Scrabble Words, go to **Settings → Import word list** and pick a `.txt` file with one word per line. The app uses the first word on each line, so lists that include definitions also work. The imported list is stored on your device.

## Running it

It's plain static files with no build step:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Browsers only allow camera access and service workers on `https://` or `localhost`. To use it on your phone, deploy it:

**Live site:** https://owentriggs.github.io/Grabble/

It's served by GitHub Pages from the `gh-pages` branch. To publish changes, push them to that branch:

```sh
git push origin HEAD:gh-pages
```

To install it, open the site on your phone and choose **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

## Updating

Cached files are served cache-first, so **bump `VERSION` in `sw.js`** whenever you change a file. Otherwise installed copies keep the old version.

## Layout

```
index.html              app shell (Scan / Type / History / Settings)
css/app.css             styles, light and dark
js/app.js               UI and state
js/ocr.js               tile segmentation and Tesseract
js/camera.js            camera stream and cropping to the guide frame
js/dictionary.js        word list, scoring, anagrams, lookalike suggestions
js/define.js            online definitions (Free Dictionary API, Wiktionary)
js/feedback.js          sounds and vibration
sw.js                   offline caching
manifest.webmanifest    PWA manifest
data/enable.txt         ENABLE word list
vendor/tesseract/       Tesseract.js 7 (Apache-2.0), core, English LSTM model
```
