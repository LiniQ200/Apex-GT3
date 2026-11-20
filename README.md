# APEX GT3

Race nine opponents over three laps of Autodromo Valle d’Oro, or select **Hotlap qualifying** for a solo session. Choose a car and livery in the garage, then **Drive**. Wait for all five red lights to go out. The pit wall shows upcoming turns, estimated entry speeds and cars alongside.

**Driving:** W/S or ↑/↓ for throttle and brake, A/D or ←/→ to steer. C changes camera, B looks back, R rejoins if there is space, and Esc pauses. Touchscreens have two-thumb steering and pedals. Gamepads use the left stick and triggers. The garage’s **Controls** menu lists the remaining bindings.

In the cockpit, read the instruments in the car. Select **MoTeC C127** to open the full telemetry panel; it remembers your choice separately for cockpit and exterior cameras during the session.

## Play a downloaded release

Phones and computers open the same 3D game. A current browser with WebGPU or WebGL 2 and graphics acceleration is recommended. High is the default on every screen. The renderer adjusts race resolution to measured frame times; the 120 Hz physics, opponents and HUD stay the same. Devices without either graphics API cannot run this game.

If launch stalls, select **Launch with WebGL 2** on the loading screen. This runs the same cars, lighting and circuit without waiting for a WebGPU device. Open the link directly in your browser if an embedded preview blocks 3D graphics.

For offline play, download the full game from the garage’s **Controls** panel and extract the entire ZIP. Run `python3 play.py` in the extracted folder (`py play.py` on Windows). It starts a loopback-only server and opens your browser. Leave the terminal open until you finish. Alternatively, serve the extracted root from any static HTTP server. Double-clicking `index.html` shows these launch instructions.

## Build from source

Use Node.js 22.12 or newer and `npm ci`. `npm run dev` starts the development server. `npm run build` checks TypeScript, builds the 3D site under `dist/`, and packages the same game in `dist/downloads/apex-gt3.zip`. `npm run preview` serves those files. For WebGPU on a hosted site, use HTTPS.

Dev and build prepare any missing assets. To prepare deliberately offline after installing the locked packages, use `npm run fetch:assets -- --offline`. When connectivity returns, `npm run fetch:assets` replaces available substitutions. No keys or third-party requests are needed while playing. See `public/credits.txt` for the car, scenery, engine and font credits.
