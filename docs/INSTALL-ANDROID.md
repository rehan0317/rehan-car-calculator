# Install on Android — max 6 steps (PWA)

No APK exists yet (no JDK/Android SDK in the build sandbox — see README).
The PWA installs from the hosted site and then works offline.

1. On the Android phone, open Chrome and go to the hosted app URL
   (deploy `dist/` — see "Hosting" below — then put the real URL here).
2. Tap the Chrome menu (⋮) → **Add to Home screen** (or **Install app**).
3. Tap **Install / Add**. The "CarCalc" icon appears on the home screen.
4. Open it once with internet on — the first load caches the whole app
   (app shell + saved routes, ~188 KiB). Wait for the Quote screen.
5. Turn on airplane mode and reopen the app from the home-screen icon.
   It must open on Quote and quote Chichawatni → Sahiwal from saved data.
6. Go to More → Settings: add your car, set petrol price (Rs/litre),
   km/litre and rate/km, then tap **Download backup (JSON)** and save the
   file to Google Drive / WhatsApp. Repeat at least once a week.

## Hosting (`dist/` → free static host, $0)

Pick one. All three are free for a static site, permanent while the
account exists, no custom domain required (a free subdomain is included).

- **GitHub Pages:** `git init && git add . && git commit -m "v1"`,
  create a repo on github.com, `git push`, repo Settings → Pages →
  Source: Deploy from branch (main, `/` — or upload `dist/` contents).
- **Cloudflare Pages:** dash.cloudflare.com → Pages → Upload assets → drop
  the `dist/` folder. Bot-challenge / "Under Attack" mode must be OFF
  (Security → Settings) or the phone will hit a CAPTCHA.
- **Netlify Drop:** app.netlify.com/drop → drag the `dist/` folder.

Verify after deploy: fetch the URL with a clean client (fresh browser
profile, no login) — it must load the Quote screen with no CAPTCHA,
no interstitial, no wait. Then install from that URL (steps above).

## APK later (UNVERIFIED — never built here)

On a PC with Android Studio installed:
`npm i @capacitor/core @capacitor/cli && npx cap init CarCalc com.chichawatni.carcalc`
`&& npx cap add android && npx cap sync && cd android && ./gradlew assembleRelease`
— then sign with a keystore you create once and **never lose**
(a lost keystore means updates cannot install over the old app; keep the
`.keystore` file + its password in a safe place, NOT in the repo).
`capacitor.config.ts` in this repo is a starting point only.
