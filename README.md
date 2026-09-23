# cimea-browser-script

A Firefox userscript that clicks a chosen button on the CIMEA site (`mywallet.cimea-diplome.it`) at an exact time (Italian time), in as many tabs as you like, each tab with its own time.

## How it works

- **Server clock:** the script measures how far your PC clock is from the CIMEA server's clock, using the `Date` header on the server's responses. It is accurate to roughly your ping. It then schedules clicks by *server* time. The first tab you arm takes the measurement (~8 s) and the other tabs reuse it.
- **Background tabs:** Firefox slows down timers in background tabs to once per second or less. The countdown runs in a Web Worker, which isn't slowed down, and a normal timer runs as a backup.
- **Summer and winter time:** times are in `Europe/Rome`, so the switch between CEST and CET is handled automatically.
- **Disabled button:** if the button is disabled at the target time, the script retries every 10 ms for up to 10 s and clicks as soon as the button is enabled.

## Install

1. Install [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) or [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) in Firefox.
2. Open the raw [`cimea-timed-click.user.js`](https://raw.githubusercontent.com/alamJamshed/cimea-browser-script/main/cimea-timed-click.user.js). The extension will offer to install it.
3. The script runs only on `mywallet.cimea-diplome.it`. The extension checks GitHub for updates automatically.

## Recommended Firefox settings

Open `about:config` and set:

| Setting | Value | Why |
|---|---|---|
| `dom.timeout.enable_budget_timer_throttling` | `false` | stops extra slowing of background-tab timers |
| `dom.min_background_timeout_value` | `4` | background-tab timers get the same precision as the visible tab |
| `browser.tabs.unloadOnLowMemory` | `false` | stops Firefox from unloading waiting tabs |
| `privacy.resistFingerprinting` | `false` | if this is on, the clock is rounded to 100 ms |

The script works without these settings; they are extra safety.

## Daily use

In each of the 15 tabs, with the final page open:

1. **Pick button** → click the button that should be pressed. The script remembers your choice, so the other tabs select the same button automatically. You'll see an orange dashed outline around it.
2. Click **W1**, **W2** or **W3**, depending on the window. You can also type a time (`HH:MM:SS`) and press **Arm**.
3. The panel turns green and shows a countdown. The tab title shows the countdown too, for example `[W1 42.3] …`.

After the click, the panel shows the server time of the click and how many ms after the target it happened. The same line is also written to the browser console.

Change the preset times, or set a fixed `BUTTON_SELECTOR`, in the `config` section at the top of the script.

## Notes

- Keep the computer awake and don't let the screen lock while waiting.
- A tab counts as "armed" only while that page stays loaded. If a tab reloads, arm it again.
- The script uses `element.click()`. If the site only accepts real mouse clicks (the `isTrusted` check), a script can't get past that.
